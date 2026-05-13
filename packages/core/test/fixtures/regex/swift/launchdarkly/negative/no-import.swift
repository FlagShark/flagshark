class Plain {
    func isEnabled() -> Bool {
        return boolVariation(forKey: "not-detected-without-import", defaultValue: false)
    }

    private func boolVariation(forKey key: String, defaultValue: Bool) -> Bool {
        return defaultValue
    }
}
