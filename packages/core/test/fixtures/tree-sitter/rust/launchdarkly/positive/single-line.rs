use launchdarkly_server_sdk::Client;

fn run(client: &Client, ctx: &Context) {
    let enabled = client.bool_variation(&ctx, "RUST_CHECKOUT_V2", false);
    let _ = enabled;
}
