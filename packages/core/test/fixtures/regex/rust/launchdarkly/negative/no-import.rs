pub fn is_enabled() -> bool {
    bool_variation("not-detected-without-import", false)
}

fn bool_variation(_key: &str, def: bool) -> bool {
    def
}
