# Generic mint quotes are reusable and key locked

Generic Payment Method mint quotes are accepted only when they provide reusable quote accounting:
the paid amount and the issued amount. Coco generates the wallet-controlled quote key for these
quotes and rejects generic mint quote responses that omit the reusable accounting fields, because
operation recovery and safe claim calculation depend on coco owning the quote key and knowing the
unissued paid value.
