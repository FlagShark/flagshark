<?php

use LaunchDarkly\LDClient;

class Example
{
    public function run($client, $ctx)
    {
        $enabled = $client->variation("php-checkout-v2", $ctx, false);
    }
}
