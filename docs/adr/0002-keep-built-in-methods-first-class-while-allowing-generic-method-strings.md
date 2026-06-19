# Keep built-in methods first-class while allowing generic method strings

Coco keeps `bolt11`, `bolt12`, and `onchain` as Built-in Payment Methods with narrow typed inputs
and return types, while adding Generic Payment Method entry points that accept arbitrary method
strings through an explicit generic payload shape. This is a breaking public API change, so coco
will use clear built-in/generic method type names rather than preserving compatibility aliases that
obscure the distinction.
