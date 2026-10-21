import Foundation
import UIKit
import Capacitor

@objc(MobileFilesPlugin)
public class MobileFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "MobileFilesPlugin"
    public let jsName = "MobileFiles"
    public let pluginMethods = [CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise)]
    private var pending: CAPPluginCall?
    private var temporaryDirectory: URL?

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
