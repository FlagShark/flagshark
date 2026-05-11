; Method call: client.variation(...)
(call
  function: (attribute
    object: (_) @receiver
    attribute: (identifier) @method)
  arguments: (argument_list) @args) @call

; Bare function call: variation(...)
(call
  function: (identifier) @method
  arguments: (argument_list) @args) @call
