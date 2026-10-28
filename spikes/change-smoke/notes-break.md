# Meeting notes: deliberate start-up failure (smoke test only)

This is a test of the safety net, not a real request. Make the app fail on purpose when it starts: on start-up it
must stop straight away with the error "smoke test: deliberate start-up failure", before it listens on any port.
Nothing else changes. The box is expected to notice that the new version does not start and undo the update.
