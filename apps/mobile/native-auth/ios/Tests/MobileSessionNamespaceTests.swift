@main
enum MobileSessionNamespaceTests {
    static func main() {
        let production = MobileSessionNamespace.service(for: "https://tomverse.app")
        let staging = MobileSessionNamespace.service(for: "https://staging.tomverse.app")
        precondition(production == "app.tomverse.mobile.session.v1", "Existing production sessions must retain their namespace")
        precondition(staging != production, "Staging must never read or clear a production credential")
        precondition(MobileSessionNamespace.service(for: "https://dev.tomverse.app") != production)
        for invalid in ["http://tomverse.app", "https://tomverse.app/", "https://other.invalid", ""] {
            precondition(MobileSessionNamespace.service(for: invalid) != production)
            precondition(MobileSessionNamespace.service(for: invalid) != staging)
        }
        print("Verified isolated iOS session namespaces")
    }
}
