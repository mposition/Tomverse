import Foundation
import Capacitor
import Security
import CryptoKit
import AuthenticationServices
import UIKit
import LocalAuthentication

@objc(MobileAuthPlugin)
public final class MobileAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "MobileAuthPlugin"
    public let jsName = "MobileAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestEmailCode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyEmailCode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceSecurity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDeviceLock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlockDevice", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "app.tomverse.mobile.session")
    private let service = "app.tomverse.mobile.session.v1"
    private var origin = "https://tomverse.app"
    private var accessToken: String?
    private var expiresAt: Double = 0
    private var pending: CAPPluginCall?
    private var verifier: String?
    private var state: String?
    private var observer: NSObjectProtocol?
    private var authentication: ASWebAuthenticationSession?
    private var deviceUnlocked = false
    private var securityObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?
    private var backgroundedAt: Date?
    private var backgrounded = false
    private var devicePrompt: LAContext?
    private var lockEnabled: Bool { UserDefaults.standard.bool(forKey: service + ".deviceLock") }
    private var deviceLocked: Bool { lockEnabled && (!deviceUnlocked || backgrounded) }

    @objc public func getDeviceSecurity(_ call: CAPPluginCall) {
        queue.async { [self] in
            let context = LAContext()
            call.resolve(["available": context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil), "enabled": lockEnabled, "locked": deviceLocked && (try? read()) != nil])
        }
    }
    private func authenticateDevice(_ call: CAPPluginCall, success: @escaping () -> Void) {
        DispatchQueue.main.async { [self] in
            guard devicePrompt == nil else { call.reject("Authentication already open", "DEVICE_AUTH_BUSY"); return }
            let context = LAContext()
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { call.reject("Configure device security first", "DEVICE_SECURITY_UNAVAILABLE"); return }
            devicePrompt = context
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: call.getString("reason") ?? "Unlock your Tomverse conversations") { [weak self] allowed, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.devicePrompt = nil
                    guard allowed && UIApplication.shared.applicationState == .active else { call.reject("Authentication cancelled", "DEVICE_AUTH_CANCELLED"); return }
                    self.queue.async { success() }
                }
            }
        }
    }
    @objc public func setDeviceLock(_ call: CAPPluginCall) {
        queue.async { [self] in
            guard (try? read()) != nil else { call.reject("Sign in first", "SIGN_IN_REQUIRED"); return }
            authenticateDevice(call) { [self] in
                UserDefaults.standard.set(call.getBool("enabled") ?? false, forKey: service + ".deviceLock")
                deviceUnlocked = true; call.resolve()
            }
        }
    }
    @objc public func unlockDevice(_ call: CAPPluginCall) {
        queue.async { [self] in
            guard deviceLocked else { call.resolve(); return }
            authenticateDevice(call) { [self] in deviceUnlocked = true; call.resolve() }
        }
    }

    public override func load() {
        origin = getConfig().getString("apiOrigin") ?? "https://tomverse.app"
        // Keychain survives uninstall; an installation marker prevents silent session adoption.
        if !UserDefaults.standard.bool(forKey: service) {
            try? clear(); UserDefaults.standard.set(true, forKey: service)
        }
        observer = NotificationCenter.default.addObserver(forName: .capacitorOpenUniversalLink, object: nil, queue: .main) { [weak self] notice in
            if let data = notice.object as? [String: Any], let url = data["url"] as? URL { self?.receive(url) }
        }
        securityObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.devicePrompt?.invalidate()
            self.queue.async { self.backgroundedAt = Date(); self.backgrounded = true }
        }
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.queue.async { if let time = self.backgroundedAt, Date().timeIntervalSince(time) >= 30 { self.deviceUnlocked = false }; self.backgrounded = false }
        }
    }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) }; if let securityObserver { NotificationCenter.default.removeObserver(securityObserver) }; if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) } }
    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "current", kSecAttrSynchronizable as String: false]
    }
    private func read() throws -> String? {
        var q = query(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let result = SecItemCopyMatching(q as CFDictionary, &item)
        if result == errSecItemNotFound { return nil }
        guard result == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else { throw Failure.storage }
        return value
    }
    private func write(_ value: String) throws {
        var q = query(); q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = SecItemAdd(q as CFDictionary, nil)
        if result == errSecDuplicateItem {
            guard SecItemUpdate(query() as CFDictionary, [kSecValueData as String: Data(value.utf8)] as CFDictionary) == errSecSuccess else { throw Failure.storage }
        } else if result != errSecSuccess { throw Failure.storage }
    }
    private func clear() throws {
        accessToken = nil; expiresAt = 0
        let result = SecItemDelete(query() as CFDictionary)
        if result != errSecSuccess && result != errSecItemNotFound { throw Failure.storage }
    }
    private enum Failure: Error { case storage, invalid, network, refused(String) }
    private func refusalCode(_ status: Int, _ body: [String: Any]) -> String {
        if status == 429 { return "MOBILE_RATE_LIMITED" }
        let code = body["code"] as? String ?? ""
        if ["EMAIL_CODE_INVALID", "EMAIL_CODE_LOCKED", "EMAIL_ACCOUNT_NOT_FOUND", "MOBILE_LOGIN_REFUSED", "TURNSTILE_REQUIRED", "TURNSTILE_FAILED", "TURNSTILE_UNAVAILABLE", "SEND_FAILED"].contains(code) { return code }
        return status == 404 || status == 503 || code == "INVALID_REQUEST_ORIGIN" ? "MOBILE_LOGIN_UNAVAILABLE" : "MOBILE_LOGIN_FAILED"
    }
    private func validateOrigin() throws {
        guard let u = URLComponents(string: origin), u.scheme == "https", ["tomverse.app", "dev.tomverse.app", "staging.tomverse.app"].contains(u.host ?? ""),
              u.port == nil, u.user == nil, u.password == nil, u.path.isEmpty, u.query == nil, u.fragment == nil else { throw Failure.invalid }
    }
    private func post(_ path: String, _ body: [String: Any]) throws -> [String: Any] { try request(path, body) }
    private func request(_ path: String, _ body: [String: Any]?, language: String? = nil) throws -> [String: Any] {
        try validateOrigin()
        guard let url = URL(string: origin + path) else { throw Failure.invalid }
        var request = URLRequest(url: url); request.httpMethod = body == nil ? "GET" : "POST"
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        if let language, ["en", "ko", "zh", "de", "fr", "es", "pt"].contains(language) { request.setValue(language, forHTTPHeaderField: "Accept-Language") }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.timeoutInterval = 25
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        let delegate = NoRedirect(); let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let semaphore = DispatchSemaphore(value: 0); var received: Data?; var code = 0
        let task = session.dataTask(with: request) { data, response, _ in received = data; code = (response as? HTTPURLResponse)?.statusCode ?? 0; semaphore.signal() }
        task.resume(); let outcome = semaphore.wait(timeout: .now() + 30)
        defer { session.invalidateAndCancel() }
        guard outcome == .success else { throw Failure.network }
        guard (200..<300).contains(code) else {
            let body = received.flatMap { $0.count <= 16384 ? (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] : nil } ?? [:]
            throw Failure.refused(refusalCode(code, body))
        }
        if code == 204 { return [:] }
        guard let received, received.count <= 16384, let body = try JSONSerialization.jsonObject(with: received) as? [String: Any] else { throw Failure.invalid }
        return body
    }
    private func accept(_ body: [String: Any]) throws {
        guard let access = body["accessToken"] as? String, !access.isEmpty, let secret = body["refreshToken"] as? String, !secret.isEmpty,
              let seconds = body["expiresIn"] as? Double, seconds > 0, seconds <= 600 else { throw Failure.invalid }
        try write(secret); accessToken = access; expiresAt = Date().timeIntervalSince1970 * 1000 + seconds * 1000
    }
    @objc public func hasSession(_ call: CAPPluginCall) {
        queue.async { [self] in
            do { call.resolve(["signedIn": try read() != nil]) }
            catch { try? clear(); call.resolve(["signedIn": false]) }
        }
    }
    @objc public func getAccessToken(_ call: CAPPluginCall) {
        queue.async { [self] in
            guard !deviceLocked else { call.reject("Unlock with device authentication", "DEVICE_LOCKED"); return }
            do {
                if let rejected = call.getString("rejectedAccessToken"), rejected == accessToken { accessToken = nil; expiresAt = 0 }
                if accessToken == nil || expiresAt <= Date().timeIntervalSince1970 * 1000 + 30000 {
                    guard let current = try read() else { throw Failure.invalid }
                    // Unknown outcomes never replay a single-use rotating secret.
                    try clear(); try accept(post("/api/auth/mobile/refresh", ["refreshToken": current]))
                }
                guard !deviceLocked else { call.reject("Unlock with device authentication", "DEVICE_LOCKED"); return }
                call.resolve(["accessToken": accessToken!, "expiresAt": expiresAt])
            } catch { try? clear(); call.reject("Sign-in required", "SIGN_IN_REQUIRED") }
        }
    }
    private func random() throws -> String {
        var data = Data(count: 32)
        let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw Failure.invalid }
        return encode(data)
    }
    private func encode(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    @objc public func signIn(_ call: CAPPluginCall) {
        queue.async { [self] in
            do {
                guard try request("/api/auth/mobile/email", nil)["browserSignIn"] as? Bool == true else { throw Failure.invalid }
                openBrowser(call)
            } catch { call.reject("Sign-in is not available on this server", "MOBILE_LOGIN_UNAVAILABLE") }
        }
    }
    private func requireEmailSupport() throws {
        do {
            let support = try request("/api/auth/mobile/email", nil)
            guard support["ok"] as? Bool == true, support["emailCode"] as? Bool == true else { throw Failure.refused("MOBILE_LOGIN_UNAVAILABLE") }
        } catch Failure.refused { throw Failure.refused("MOBILE_LOGIN_UNAVAILABLE") }
        catch Failure.invalid { throw Failure.refused("MOBILE_LOGIN_UNAVAILABLE") }
    }
    @objc public func requestEmailCode(_ call: CAPPluginCall) {
        queue.async { [self] in
            do {
                guard let email = call.getString("email"), email.count <= 320 else { throw Failure.invalid }
                try requireEmailSupport()
                _ = try request("/api/auth/mobile/email", ["action": "request", "email": email], language: call.getString("language"))
                call.resolve()
            } catch Failure.refused(let code) { call.reject("Could not send sign-in code", code) }
            catch { call.reject("Could not send sign-in code", "MOBILE_LOGIN_FAILED") }
        }
    }
    @objc public func verifyEmailCode(_ call: CAPPluginCall) {
        queue.async { [self] in
            do {
                guard let email = call.getString("email"), email.count <= 320, let code = call.getString("code"), code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else { throw Failure.refused("EMAIL_CODE_INVALID") }
                try clear()
                try accept(post("/api/auth/mobile/email", ["action": "verify", "email": email, "code": code, "platform": "ios", "deviceLabel": UIDevice.current.model]))
                deviceUnlocked = true
                call.resolve()
            } catch Failure.refused(let code) { try? clear(); call.reject("Could not verify sign-in code", code) }
            catch { try? clear(); call.reject("Could not verify sign-in code", "MOBILE_LOGIN_FAILED") }
        }
    }
    private func openBrowser(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            guard pending == nil else { call.reject("Sign-in already in progress", "LOGIN_IN_PROGRESS"); return }
            do {
                try validateOrigin(); let value = try random(); let nonce = try random(); verifier = value; state = nonce; pending = call
                var url = URLComponents(string: origin + "/auth/mobile")!
                url.queryItems = [URLQueryItem(name: "code_challenge", value: encode(Data(SHA256.hash(data: Data(value.utf8))))), URLQueryItem(name: "state", value: nonce)]
                guard #available(iOS 17.4, *) else { throw Failure.invalid }
                let session = ASWebAuthenticationSession(url: url.url!, callback: .https(host: url.host!, path: "/auth/mobile/callback")) { [weak self] callback, _ in
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.authentication = nil
                        if let callback { self.receive(callback) }
                        else if self.pending === call { self.pending = nil; self.verifier = nil; self.state = nil; call.reject("Sign-in cancelled", "LOGIN_CANCELLED") }
                    }
                }
                authentication = session; session.presentationContextProvider = self
                guard session.start() else { authentication = nil; throw Failure.invalid }
                DispatchQueue.main.asyncAfter(deadline: .now() + 180) { [weak self] in
                    guard let self, self.pending === call else { return }
                    self.pending = nil; self.verifier = nil; self.state = nil; self.authentication?.cancel(); self.authentication = nil; call.reject("Sign-in expired", "LOGIN_EXPIRED")
                }
            } catch { pending = nil; verifier = nil; state = nil; call.reject("Could not open sign-in", "LOGIN_UNAVAILABLE") }
        }
    }
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
    private func receive(_ url: URL) {
        guard let call = pending, let verifier, let state,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.query == nil else { return }
        let fragment = parts.fragment; parts.fragment = nil
        guard parts.url?.absoluteString == origin + "/auth/mobile/callback" else { return }
        let params = URLComponents(string: "https://callback.invalid/?" + (fragment ?? ""))?.queryItems ?? []
        guard params.first(where: { $0.name == "state" })?.value == state, let grant = params.first(where: { $0.name == "grant" })?.value else { return }
        pending = nil; self.verifier = nil; self.state = nil
        queue.async { [self] in
            do { try clear(); try accept(post("/api/auth/mobile/exchange", ["grant": grant, "codeVerifier": verifier, "platform": "ios", "deviceLabel": UIDevice.current.model])); deviceUnlocked = true; call.resolve() }
            catch { try? clear(); call.reject("Sign-in failed. Start again.", "LOGIN_FAILED") }
        }
    }
    @objc public func signOut(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: service + ".deviceLock")
        DispatchQueue.main.async { [self] in pending?.reject("Sign-in cancelled", "LOGIN_CANCELLED"); pending = nil; verifier = nil; state = nil; authentication?.cancel(); authentication = nil }
        queue.async { [self] in
            do { let current = try read(); try clear(); if let current { _ = try post("/api/auth/mobile/logout", ["refreshToken": current]) }; call.resolve() }
            catch { try? clear(); call.reject("Signed out locally; device revocation could not be confirmed", "LOGOUT_UNCONFIRMED") }
        }
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
