use launchdarkly_server_sdk::Client;

pub fn checkout(client: &Client, context: &Context) -> &'static str {
    let enabled = client.bool_variation(context, "CHECKOUT_V2", false);
    if enabled {
        return "v2";
    }
    "v1"
}
