# AFL VM Interruption Recovery

Status: v0 implementation decision

This document defines the recovery boundary of the AFL VM. Recovery preserves
AFL-owned workflow state and Agent conversation state. It does not attempt to
snapshot or roll back the external world.

## 1. Design decision

An interrupted run is resumed by replaying the root flow from its entry and
substituting durable results at VM-owned boundaries. AFL does not serialize the
instruction pointer, stack, every local value, or every branch transition.

The durable state consists of:

- run identity and lifecycle;
- canonical Memory and executor-native continuation records;
- prepared, interrupted, and completed `agent.do` operations;
- completed VM-owned dynamic control operations;
- durable human input and transaction results;
- enough progress information to reuse completed local parallel children.

Pure IR is replayed. User-managed external calls may also be replayed. Explicit
`resume` is required; starting a run normally never silently resumes an older
interrupted run.

## 2. Guarantee boundary

### 2.1 What AFL guarantees

For a compatible interrupted run, the VM guarantees that:

1. canonical Memory is restored without duplicating an already durable input or
   assistant result;
2. a compatible executor continuation can restore complete semantic records such
   as thinking, tool calls, and tool results;
3. a completed `agent.do` result can be reused during replay;
4. an interrupted `agent.do` is presented to the executor as a resume activation;
5. completed local Agent children in a dispatch are reused while interrupted
   children continue;
6. completed Freedom control results and accepted human results are not silently
   presented twice;
7. incompatible source, bindings, executor identity, or continuation format fail
   explicitly;
8. one top-level run has only one active recovery writer.

These are guarantees about AFL state, not about files, processes, databases,
remote services, or other effects produced by tools.

### 2.2 What AFL does not guarantee

AFL does not provide exactly-once execution, rollback, or automatic reconciliation
for arbitrary side effects. In particular it does not guarantee that:

- a model tool did not partially modify a Workspace before interruption;
- a shell command, compiler, database request, or remote API can be repeated
  safely;
- an `invoke`, script binding, or external flow runs only once;
- a Workspace matches some earlier filesystem snapshot;
- switching executor or model infrastructure preserves native continuation
  semantics.

This is intentional. A complete snapshot of a workflow cannot atomically include
every external system it may touch. Adding more VM records cannot turn that into
an exactly-once protocol.

## 3. Side-effect ownership

### 3.1 Tools used by a model

Model tools remain subject to AFL safety policy, sandboxing, approval, and
elevation. Their calls and results are persisted as part of the executor session
when the executor provides complete semantic continuation records.

They are not separate VM recovery operations. The host interface therefore has
no prepare/commit protocol for ordinary tool effects.

After an interruption, the restored Agent observes the durable conversation and
current Workspace. The Agent and executor decide whether to inspect existing
state, retry a tool, repair a partial result, or choose a different method. This
is the same practical boundary used by interactive coding Agents: conversation
recovery can be reliable without claiming transactional recovery of every command.

Security and recovery are separate concerns:

- `authorizeTool` runs before a normal tool execution;
- `requestElevation` is used only after the model explicitly chooses an elevated
  retry;
- bubblewrap or another executor sandbox constrains the actual execution;
- none of these mechanisms implies that a permitted side effect is reversible.

### 3.2 `invoke`, scripts, and external flows

These are user-managed binding boundaries. They execute directly and may execute
again when the root flow is replayed. Binding authors should prefer pure functions
and otherwise provide their own idempotency key, reconciliation, or transaction
semantics where needed.

`compute` is a VM builtin over `ComputeValue`; it remains pure and is simply
re-evaluated.

Local Node calls are different from external flows. Their internal VM-owned Agent
operations still have stable recovery identities, so completed model work can be
reused even though the local control path is replayed.

### 3.3 Human control operations

`requestInput`, transaction requests, and Freedom control calls are VM-hosted
protocol operations rather than ordinary model tools. Their accepted result
changes workflow control state, so the VM journals the result and its delivery to
the executor.

If interruption happens while such a request may already have been presented but
no durable answer exists, the VM may stop as ambiguous instead of presenting it a
second time. This narrow ambiguity rule protects user interaction; it is not a
general side-effect transaction system.

## 4. Safe points and persistence cost

`agent.do`, branch selection (`jump`, `branch`, `match`), and dispatch convergence
are semantic safe points: the in-process VM state is coherent there. A semantic
safe point does not require a disk snapshot.

The v0 VM writes at externally meaningful AFL boundaries instead:

- run start, resume, completion, interruption, or failure;
- Agent activation prepare, continuation progress, interruption, and completion;
- Memory mutation and committed Agent output;
- VM-owned dynamic control and accepted human results.

Pure arithmetic, string processing, jumps, matches, loops, and scheduler steps do
not generate a checkpoint record on every transition. This keeps persistence cost
proportional to expensive workflow work rather than branch count.

A future control checkpoint may accelerate replay of a very long pure prefix. It
is an optimization, not a stronger side-effect guarantee.

## 5. Agent recovery

Before executor activation the VM durably records the `agent.do` identity, input,
format, Memory revision, Agent binding, Workspace identity, and compatible
executor identity.

During execution, the executor may append complete continuation records. The VM
does not require token-level snapshots; it persists semantic entries that the
executor can import again.

On normal completion the ordering is:

1. validate the executor result and requested format;
2. append the canonical assistant message;
3. update the compatible executor session reference;
4. persist Memory;
5. mark the `agent.do` operation complete;
6. publish the result to dependent IR.

On infrastructure interruption the VM records an interrupted Agent attempt and
run. It preserves durable Memory and continuation state. On resume it does not
append the user input a second time and passes a resume activation to the executor.

If a complete assistant output is already durable but the outer operation was not
marked complete, the VM may reconcile the `agent.do` result from that durable
Memory boundary. Ordinary tool calls do not block this reconciliation.

## 6. Replay behavior

Recovery starts at the root entry using the same root module digest, entry,
portable arguments, binding identity, execution root, and executor identity.

During replay:

- `oper`, `compute`, branches, loops, and local scheduling run again;
- Memory handles are restored by stable allocation slot;
- completed Agent operations return their durable result;
- interrupted Agent operations resume from durable Memory/session state;
- completed local dispatch children are reused;
- `invoke`, script bindings, and external flows execute again if reached;
- VM-owned control and accepted human results are replayed from their journal.

The flow author must therefore keep pure replay deterministic enough to reach the
same VM-owned operation identities. A changed module or binding identity is
rejected rather than guessed.

## 7. Failure classification

A run ends in one of three durable states:

- `completed`: the root result is durable;
- `interrupted`: infrastructure, cancellation, or persistence failure left a run
  that may be explicitly resumed;
- `failed`: deterministic AFL validation or workflow failure is terminal for that
  run identity.

Persistence failure is terminal for the current process because the VM can no
longer promise correct Memory or workflow-state recovery. This says nothing about
whether an already started external effect occurred.

Cancellation is cooperative. The VM aborts active work, waits for in-process
cleanup where possible, flushes completed Memory records, and records interruption.
A hard process kill may leave no tail record; already complete records remain the
recovery source.

## 8. Storage and compatibility

Recovery metadata lives under `.afl/recovery` by default. Canonical Memory and
executor continuation records live under `.afl/memory`. Stores may be replaced by
bindings but must preserve append ordering, bounded records, atomic publication,
and exclusive top-level run ownership.

Recovery requires compatible:

- root module digest and entry arguments;
- binding fingerprint or derived binding identity;
- executor name, recovery identity, and session format;
- Memory role schema and Workspace identity.

Native continuation is executor-specific. AFL Memory remains model- and
platform-independent at the language level, but a persisted native session must
not be silently imported by another executor.

## 9. Security relationship

Recovery does not add an authorization bypass. A replayed `invoke` passes through
its capability policy again, and resumed Agent tools use the normal pre-tool
policy, approval, elevation, and sandbox path. Script and external-flow bindings
remain user-managed and must enforce any policy their host requires.

The recovery store must reject path traversal, symlink substitution, oversized
records, invalid state transitions, digest mismatches, and concurrent writers.
Secrets should not be copied into recovery metadata. Session and Memory content
follow their existing storage policy.

## 10. Required tests

The recovery suite should cover:

1. explicit resume without duplicated Agent input;
2. Memory and native continuation import compatibility;
3. reuse of completed Agent calls and local dispatch children;
4. continuation of interrupted Agent calls;
5. model tool calls remaining authorized but absent from the VM operation journal;
6. replay of `invoke`, script, and external-flow bindings;
7. durable replay of Freedom control and human results;
8. cancellation, persistence failure, truncated tails, and exclusive writer
   behavior;
9. rejection of changed module, binding, executor, role schema, or Workspace;
10. normal safety policy and sandbox enforcement after resume.

Tests must not assert exactly-once behavior for arbitrary model tools or external
bindings. Where a test binding has side effects, it should explicitly implement or
simulate its own idempotency policy.

## 11. Deferred work

- compact control checkpoints for replay performance;
- operator tooling to inspect interrupted runs and Memory;
- explicit graceful-shutdown coordination across multiple executors;
- configurable retention and garbage collection;
- richer reconciliation hooks supplied by a binding that owns a particular
  external system.

These additions may improve operability. They must not expand the core claim into
transactional recovery of arbitrary external effects.
