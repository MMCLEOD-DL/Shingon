# API conventions

## Error responses

Every API error is returned as a JSON object with an error code, a plain English message, a retryable flag and a request id. Never include a stack trace or a credential.

## Pagination

List endpoints return at most 100 items and a cursor for the next page.
