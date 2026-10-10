# Starting the first consumer migration

The foundation is ready for an initial consumer port. Begin with the shared tool brief, following
the [consumer review's migration order](../../../docs/proposals/structured-prompts-review.md).
The package is private and its authoring APIs can still evolve with integration feedback. The
stored schema/compiler contract already has compatibility fixtures and must be preserved.

1. Build the site's composition with this package's own nodes and tool declarations. A boundary
   conversion from the consumer's current input shape is appropriate; the foundation must not
   import the consumer's renderer, state, transport, or execution callbacks.
2. Capture acquired facts in `snapshot` context and express session-dependent choices with `Case`.
   Use `ToolBrief`'s budget policy for usage removal, rather than truncating the emitted string.
3. Store `serializeRecord(record)` in the consumer's ledger and test loading it through `parseRecord`
   and `rehydrate`. Replaying a record must not execute author code or consult current session state.
4. Compare the port with the site's baseline corpus and review meaningful differences. The corpus
   documents current output; it does not require preserving accidental whitespace, spelling, or
   renderer behavior. Add consumer tests for the intended new behavior.
5. Keep sending and asset preparation with the consumer. Use a utility lowerer where it fits, or
   implement the versioned `ConsumerAdapter` contract. Capture the actual payload at the transport
   boundary if wire verification is needed. A prepared payload alone is not a sent receipt.

The [record contract](record-contract.md) is the implemented API guide; the larger architecture
proposal also describes future work. Before adding `.prompt.tsx` to a Solid application, apply the
[routing configuration](jsx-routing.md). UI theming, inline preview behavior, and cost badges are
independent of the stored records and do not block this migration.

Small fixes from consumers are welcome. Include a focused regression test for the reported input.
If a change affects retained meaning, decision derivation, or emitted output, check the static v1
fixtures and decide explicitly whether it needs a new compiler version. Retained records must
continue to use the implementation matching their recorded version. Do not update a compatibility
fixture merely to make a changed derivation pass. Ordinary
UI fixes can evolve without a semantic schema change.
