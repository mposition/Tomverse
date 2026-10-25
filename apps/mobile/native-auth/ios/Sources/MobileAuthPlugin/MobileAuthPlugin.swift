import Capacitor
import CryptoKit
import Foundation
import Security

private enum SessionFailure: Error { case unavailable }

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@objc(MobileAuthPlugin)
public class MobileAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileAuthPlugin"
    public let jsName = "MobileAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        .init(name: "beginSignIn", returnType: CAPPluginReturnPromise),
        .init(name: "completeSignIn", returnType: CAPPluginReturnPromise),
        .init(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        .init(name: "hasSession", returnType: CAPPluginReturnPromise),
        .init(name: "signOut", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "app.tomverse.mobile-auth")
    private let service = "app.tomverse.mobile.auth.v1"
    private var accessToken: String?
    private var expiresAt: Double = 0
    private var verifier: String?
    private var verifierExpiresAt: TimeInterval = 0
    private var installationReady = false

    private var enabled: Bool { getConfig().getBoolean("enabled", false) }

    private func origin() throws -> String {
        guard let parts = URLComponents(string: getConfig().getString("apiOrigin", "https://tomverse.app")),
              parts.scheme == "https", parts.host != nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              var base = parts.url?.absoluteString else { throw SessionFailure.unavailable }
        if base.hasSuffix("/") { base.removeLast() }
        return base
    }

    private var keyQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "session", kSecAttrSynchronizable as String: false]
    }

    public override func load() {
        queue.async {
            // Keychain retention on uninstall is not assumed. Clear on a fresh local installation.
            let marker = "tomverse.mobile.auth.installed.v1"
            if !UserDefaults.standard.bool(forKey: marker) {
                do { try self.clear(); UserDefaults.standard.set(true, forKey: marker); self.installationReady = true }
                catch { /* Remain signed out if the secure store is unavailable. */ }
            } else { self.installationReady = true }
        }
    }

    private func stored() throws -> String? {
        var query = keyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = item as? Data,
              let payload = try JSONSerialization.jsonObject(with: bytes) as? [String: String],
              payload["origin"] == (try origin()), let credential = payload["credential"] else {
            throw SessionFailure.unavailable
        }
        return credential
    }

    private func save(_ credential: String) throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["origin": try origin(), "credential": credential])
        let removed = SecItemDelete(keyQuery as CFDictionary)
        guard removed == errSecSuccess || removed == errSecItemNotFound else { throw SessionFailure.unavailable }
        var query = keyQuery
        query[kSecValueData as String] = bytes
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw SessionFailure.unavailable }
    }

    private func clear() throws {
        accessToken = nil; expiresAt = 0; verifier = nil; verifierExpiresAt = 0
        let status = SecItemDelete(keyQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SessionFailure.unavailable }
    }

    private func post(_ path: String, _ body: [String: Any]) throws -> [String: Any] {
        guard let url = URL(string: try origin() + path) else { throw SessionFailure.unavailable }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil
        config.urlCache = nil; config.timeoutIntervalForResource = 20
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        let semaphore = DispatchSemaphore(value: 0)
        var result: Data?
        var status = 0
        var failed = false
        let task = session.dataTask(with: request) { data, response, error in
            result = data; status = (response as? HTTPURLResponse)?.statusCode ?? 0
            failed = error != nil; semaphore.signal()
        }
        task.resume()
        defer { session.invalidateAndCancel() }
        guard semaphore.wait(timeout: .now() + 21) == .success, !failed else { throw SessionFailure.unavailable }
        if status == 204 { return [:] }
        guard status == 200, let bytes = result, bytes.count <= 32_768,
              let json = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw SessionFailure.unavailable }
        return json
    }

    private func accept(_ tokens: [String: Any]) throws {
        guard let access = tokens["accessToken"] as? String, !access.isEmpty, access.count <= 16_384,
              let refresh = tokens["refreshToken"] as? String, !refresh.isEmpty, refresh.count <= 512,
              let seconds = tokens["expiresIn"] as? Int, seconds > 0, seconds <= 600 else { throw SessionFailure.unavailable }
        try save(refresh)
        accessToken = access; expiresAt = Date().timeIntervalSince1970 * 1_000 + Double(seconds) * 1_000
    }

    private func perform(_ call: CAPPluginCall, _ work: @escaping () throws -> Void) {
        queue.async {
            do {
                guard self.enabled && self.installationReady else { throw SessionFailure.unavailable }
                try work()
            } catch {
                // Validation and read failures preserve the existing session.
                call.reject("Mobile session unavailable. Connect your account again.", "MOBILE_AUTH_UNAVAILABLE")
            }
        }
    }

    private func mutateSession(_ path: String, _ body: [String: Any]) throws {
        do { try accept(post(path, body)) }
        catch {
            // A single-use mutation may have completed. Never retain/replay it.
            try? clear(); throw error
        }
    }

    @objc public func beginSignIn(_ call: CAPPluginCall) {
        perform(call) {
            guard try self.stored() == nil else { throw SessionFailure.unavailable }
            var random = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw SessionFailure.unavailable }
            let encode: (Data) -> String = { $0.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
            let proof = encode(Data(random))
            self.verifier = proof; self.verifierExpiresAt = Date().timeIntervalSince1970 + 600
            let challenge = encode(Data(SHA256.hash(data: Data(proof.utf8))))
            call.resolve(["url": try self.origin() + "/mobile/connect?codeChallenge=" + challenge])
        }
    }

    @objc public func completeSignIn(_ call: CAPPluginCall) {
        perform(call) {
            guard try self.stored() == nil else { throw SessionFailure.unavailable }
            guard let grant = call.getString("grant"), !grant.isEmpty, grant.count <= 512,
                  let proof = self.verifier, self.verifierExpiresAt > Date().timeIntervalSince1970 else { throw SessionFailure.unavailable }
            self.verifier = nil; self.verifierExpiresAt = 0
            try self.mutateSession("/api/auth/mobile/exchange", ["grant": grant, "codeVerifier": proof, "platform": "ios", "deviceLabel": "iPhone or iPad"])
            call.resolve()
        }
    }

    @objc public func getAccessToken(_ call: CAPPluginCall) {
        perform(call) {
            if self.accessToken == nil || self.expiresAt <= Date().timeIntervalSince1970 * 1_000 + 5_000 {
                guard let credential = try self.stored() else { throw SessionFailure.unavailable }
                try self.clear()
                try self.mutateSession("/api/auth/mobile/refresh", ["refreshToken": credential])
            }
            guard let access = self.accessToken else { throw SessionFailure.unavailable }
            call.resolve(["accessToken": access, "expiresAt": self.expiresAt])
        }
    }

    @objc public func hasSession(_ call: CAPPluginCall) {
        queue.async {
            do {
                guard self.enabled && self.installationReady else {
                    call.resolve(["signedIn": false]); return
                }
                let signedIn = try self.stored() != nil
                call.resolve(["signedIn": signedIn])
            } catch { call.resolve(["signedIn": false]) }
        }
    }

    @objc public func signOut(_ call: CAPPluginCall) {
        queue.async {
            let credential = try? self.stored()
            do { try self.clear() }
            catch { call.reject("Could not clear the device session.", "MOBILE_AUTH_UNAVAILABLE"); return }
            if self.enabled, let credential = credential {
                // Local state was removed first. An unknown remote outcome is not retried.
                _ = try? self.post("/api/auth/mobile/logout", ["refreshToken": credential])
            }
            call.resolve()
        }
    }
}
