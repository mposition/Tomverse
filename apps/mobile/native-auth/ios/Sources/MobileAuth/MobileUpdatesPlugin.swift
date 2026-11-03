import Foundation
import UIKit
import Capacitor

@objc(MobileUpdatesPlugin)
public class MobileUpdatesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileUpdatesPlugin"
    public let jsName = "MobileUpdates"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "check", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    @objc public func check(_ call: CAPPluginCall) {
        let installed = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let system = ProcessInfo.processInfo.operatingSystemVersion
        let systemVersion = "\(system.majorVersion).\(system.minorVersion).\(system.patchVersion)"
        var components = URLComponents(string: "https://itunes.apple.com/lookup")!
        components.queryItems = [
            URLQueryItem(name: "id", value: "6827148073"),
            URLQueryItem(name: "entity", value: "software"),
            URLQueryItem(name: "country", value: Locale.current.regionCode ?? "US")
        ]
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 8
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration)
        session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            var lookup: [String: Any] = ["results": []]
            if error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
               let data, data.count <= 131_072,
               let object = try? JSONSerialization.jsonObject(with: data),
               let result = object as? [String: Any] { lookup = result }
            call.resolve(["installedVersion": installed, "systemVersion": systemVersion, "lookup": lookup])
        }.resume()
    }

    @objc public func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // The app ID and destination are fixed; JavaScript cannot supply a URL.
            let url = URL(string: "https://apps.apple.com/app/id6827148073")!
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve(["accepted": true]) }
                else { call.reject("App Store could not be opened", "UPDATE_STORE_UNAVAILABLE") }
            }
        }
    }
}
