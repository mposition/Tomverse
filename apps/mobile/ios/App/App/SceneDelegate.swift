import UIKit
import Capacitor
import WebKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MobileBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

final class MobileBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        let auth = instanceConfiguration.pluginConfigurations["MobileAuth"] as? [String: Any]
        switch auth?["apiOrigin"] as? String {
        case "https://tomverse.app":
            break // Retain the installed production data store and drafts.
        case "https://staging.tomverse.app":
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "8A717CC8-6D06-46EB-99A1-CFE682FA9D17")!)
        default:
            configuration.websiteDataStore = .nonPersistent()
        }
        return configuration
    }
}
