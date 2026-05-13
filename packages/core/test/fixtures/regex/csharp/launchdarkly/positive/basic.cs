using LaunchDarkly.Sdk.Server;

public class Checkout
{
    private readonly LdClient client;

    public Checkout(LdClient client)
    {
        this.client = client;
    }

    public string Run(Context context)
    {
        bool enabled = client.BoolVariation("CHECKOUT_V2", context, false);
        if (enabled)
        {
            return "v2";
        }
        return "v1";
    }
}
