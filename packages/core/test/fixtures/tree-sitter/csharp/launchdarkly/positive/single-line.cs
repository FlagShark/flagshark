using LaunchDarkly.Sdk.Server;

public class Example
{
    public void Run(LdClient client, Context ctx)
    {
        bool enabled = client.BoolVariation("CS_CHECKOUT_V2", ctx, false);
    }
}
