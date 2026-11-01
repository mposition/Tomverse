enum MobileSessionNamespace {
    static func service(for origin: String) -> String {
        switch origin {
        case "https://tomverse.app": return "app.tomverse.mobile.session.v1"
        case "https://staging.tomverse.app": return "app.tomverse.mobile.session.v1.staging"
        case "https://dev.tomverse.app": return "app.tomverse.mobile.session.v1.dev"
        default: return "app.tomverse.mobile.session.v1.unconfigured"
        }
    }
}
