import ldclient
from ldclient.config import Config

ldclient.set_config(Config("sdk-key"))
client = ldclient.get()

def checkout(user):
    if client.variation("PY_CHECKOUT_V2", user, False):
        return "v2"
    return "v1"
