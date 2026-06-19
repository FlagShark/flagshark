fn run(client: &Client, ctx: &Context) {
    // bool_variation call with no SDK import, so the import gate skips it.
    let _ = client.bool_variation(&ctx, "RUST_NO_IMPORT", false);
}
