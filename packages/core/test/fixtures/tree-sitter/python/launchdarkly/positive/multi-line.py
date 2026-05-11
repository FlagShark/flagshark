import ldclient

client = ldclient.get()

def multi(user):
    return client.variation(
        "PY_MULTI_LINE",
        user,
        False,
    )
