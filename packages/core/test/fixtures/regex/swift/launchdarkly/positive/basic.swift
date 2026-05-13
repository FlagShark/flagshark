import LaunchDarkly

class Checkout {
    let client: LDClient

    init(client: LDClient) {
        self.client = client
    }

    func run() -> String {
        let enabled = client.boolVariation(forKey: "CHECKOUT_V2", defaultValue: false)
        if enabled {
            return "v2"
        }
        return "v1"
    }
}
