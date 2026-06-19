# Preserve raw generic quote responses

Generic Payment Method quotes expose `rawQuoteData` as the JSON object returned by the mint before
coco converts lifecycle fields into domain values. Generic quote adapter calls therefore need
access to the raw mint response as well as parsed lifecycle fields, because callers use Generic
Payment Methods precisely when method-specific response fields are not known to coco.
