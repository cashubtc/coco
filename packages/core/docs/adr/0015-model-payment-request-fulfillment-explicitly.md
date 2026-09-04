# Model payment request fulfillment explicitly

Status: accepted

Coco distinguishes the Payment Request Amount, Payment Request Method Fee, input fee, and Payment
Request Delivery Amount in its persisted operations and APIs. It presents structured Payment
Request Candidates without selecting one implicitly, while temporarily retaining bare payable-mint
URLs as a derived compatibility field; receiver-created requests expose the same mint-preference
and supported-method model that Coco accepts as a payer.

## Considered Options

We rejected overloading one `amount` field because it obscures what the receiver requires versus
what the payer delivers. We rejected automatic mint selection because trust, available balance,
method support, and total delivery cost are choices applications must be able to present.

## Consequences

The compatibility `amount` remains the Payment Request Amount. The underlying Send Operation uses
the Payment Request Delivery Amount, while history and API results expose the complete cost
breakdown.

This target model is delivered in a dedicated payment-request PR, not in the cashu-ts rc.7 upgrade
feature. Until that follow-up lands, Coco retains its legacy strict-list and gross-amount behavior,
and fails closed during payment-request parsing on requests using advisory mint lists or supported
melt methods. Such requests never expose `payableMints` or reach preparation.
