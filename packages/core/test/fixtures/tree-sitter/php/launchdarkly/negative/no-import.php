<?php

class NoImport
{
    public function run($client)
    {
        // variation call with no SDK import, so the import gate skips it.
        $client->variation("php-no-import", null, false);
    }
}
