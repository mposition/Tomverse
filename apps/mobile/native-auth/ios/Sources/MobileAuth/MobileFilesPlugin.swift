import Foundation
import UIKit
import Capacitor

@objc(MobileFilesPlugin)
public class MobileFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "MobileFilesPlugin"
    public let jsName = "MobileFiles"
    public let pluginMethods = [CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "uploadFile", returnType: CAPPluginReturnPromise)]
    private var pending: CAPPluginCall?
    private var temporaryDirectory: URL?

    @objc public func uploadFile(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), raw.count <= 8192, let parts = URLComponents(string: raw),
              parts.scheme == "https", let host = parts.host,
              host.range(of: "^[a-z0-9-]+\\.r2\\.cloudflarestorage\\.com$", options: .regularExpression) != nil,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              parts.queryItems?.contains(where: { $0.name == "X-Amz-Signature" }) == true, let url = parts.url,
              let headers = call.getObject("headers") as? [String: String], headers.count <= 12,
              headers.allSatisfy({ key, value in key.range(of: "^(content-type|x-amz-[a-z0-9-]+)$", options: [.regularExpression, .caseInsensitive]) != nil && value.count <= 2048 && !value.contains("\r") && !value.contains("\n") }),
              let encoded = call.getString("data"), encoded.utf8.count <= 90_000_000,
              let bytes = Data(base64Encoded: encoded), bytes.count <= 64 * 1024 * 1024 else { call.reject("Invalid upload", "UPLOAD_FAILED"); return }
        var request = URLRequest(url: url); request.httpMethod = "PUT"; request.httpBody = bytes; request.timeoutInterval = 45
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        let session = URLSession(configuration: config, delegate: MobileUploadRedirects(), delegateQueue: nil)
        session.dataTask(with: request) { _, response, error in
            defer { session.finishTasksAndInvalidate() }
            if error == nil, let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) { call.resolve() }
            else { call.reject("File upload failed", "UPLOAD_FAILED") }
        }.resume()
    }

    @objc public func saveFile(_ call: CAPPluginCall) {
        guard let name = call.getString("filename"), !name.isEmpty, name != ".", name != "..", name.count <= 160,
              name.rangeOfCharacter(from: .controlCharacters) == nil, !name.contains("/"), !name.contains("\\"),
              let encoded = call.getString("data"), encoded.utf8.count <= 90_000_000,
              let bytes = Data(base64Encoded: encoded), bytes.count <= 64 * 1024 * 1024 else {
            call.reject("File cannot be saved", "FILE_INVALID"); return
        }
        DispatchQueue.main.async { [self] in
            guard pending == nil, let controller = bridge?.viewController else { call.reject("A save is already open", "FILE_SAVE_BUSY"); return }
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                temporaryDirectory = directory
                let file = directory.appendingPathComponent(name)
                try bytes.write(to: file, options: [.atomic, .completeFileProtection])
                let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                picker.delegate = self; pending = call
                controller.present(picker, animated: true)
            } catch { cleanup(); call.reject("File could not be saved", "FILE_SAVE_FAILED") }
        }
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let call = pending; cleanup(); call?.resolve()
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let call = pending; cleanup(); call?.reject("Save cancelled", "FILE_SAVE_CANCELLED")
    }
    private func cleanup() {
        if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
        temporaryDirectory = nil; pending = nil
    }
}

private final class MobileUploadRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
