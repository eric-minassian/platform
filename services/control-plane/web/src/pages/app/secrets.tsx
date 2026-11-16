/**
 * An app's secrets as the stage in view sees them: its own and the shared
 * ones (all stages), which of them the live deployment declares, and the
 * declared ones nobody has set. Values are write-only: set or replace one,
 * or delete it after confirming; nothing ever reads a value back.
 */
import { useAtom, useAtomValue } from '@effect/atom-react';
import { ENV_NAME_PATTERN, type SecretInfo } from '@ericminassian/platform-core';
import { Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  EmptyState,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  StatusPill,
  type Tone,
} from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Field, FieldDescription, FieldLabel, FieldSet, FieldLegend } from '../../components/ui/field.tsx';
import { Input } from '../../components/ui/input.tsx';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group.tsx';
import { family } from '../../data/atoms.ts';
import { fmtDateTime, relTime } from '../../format.ts';
import { useStage } from '../../lib/hooks.ts';
import { appRoute } from '../../router.tsx';

/** Reactivity key of an app's secrets, on every stage. */
const secretsChanged = (app: string) => [`secrets:${app}`];

const secretsAtom = family((k: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('manage', 'secrets', {
      params: { app: k.app },
      query: { stage: k.stage },
      reactivityKeys: secretsChanged(k.app),
      timeToLive,
    }),
  ),
);
const putSecretAtom = ApiClient.mutation('manage', 'putSecret');
const deleteSecretAtom = ApiClient.mutation('manage', 'deleteSecret');

type Scope = 'shared' | 'stage';

/** What the dialog sets: a new secret (no name yet), a declared one, or an existing value to replace. */
interface Editing {
  readonly name: string;
  readonly scope: Scope;
  readonly replacing: boolean;
}

/** A secret that's set, or one the live deployment declares that isn't. */
interface Row {
  readonly name: string;
  readonly scope: Scope | undefined;
  readonly declared: boolean;
  readonly updatedAt: string | undefined;
}

const STATE: Record<'set' | 'unused' | 'missing', { tone: Tone; label: string }> = {
  set: { tone: 'ok', label: 'Set' },
  unused: { tone: 'muted', label: 'Not declared' },
  missing: { tone: 'bad', label: 'Missing' },
};
const stateOf = (r: Row) => (r.scope === undefined ? 'missing' : r.declared ? 'set' : 'unused');

/** Without `scope`, the server targets the stage's own secret. */
const target = (stage: string, scope: Scope) => ({
  stage,
  scope: scope === 'shared' ? ('shared' as const) : undefined,
});

export function SecretsPage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const result = useAtomValue(secretsAtom({ app, stage }));
  const [editing, setEditing] = useState<Editing | null>(null);
  return (
    <>
      <PageHeader
        title="Secrets"
        description="Write-only: a value is never shown again. Running code picks up a change within about 5 minutes."
        actions={
          <Button size="sm" onClick={() => setEditing({ name: '', scope: 'shared', replacing: false })}>
            <Plus />
            Add secret
          </Button>
        }
      />
      <Loaded result={result}>
        {(d) => (
          <SecretsTable
            app={app}
            stage={stage}
            secrets={d.secrets}
            declared={d.declared}
            missing={d.missing}
            onEdit={setEditing}
          />
        )}
      </Loaded>
      <SecretDialog
        app={app}
        stage={stage}
        initial={editing}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </>
  );
}

function SecretsTable({
  app,
  stage,
  secrets,
  declared,
  missing,
  onEdit,
}: {
  app: string;
  stage: string;
  secrets: readonly SecretInfo[];
  declared: readonly string[];
  missing: readonly string[];
  onEdit: (secret: Editing) => void;
}) {
  const [del, deleteSecret] = useAtom(deleteSecretAtom, { mode: 'promiseExit' });
  const rows: Row[] = useMemo(
    () => [
      ...missing.map((name) => ({ name, scope: undefined, declared: true, updatedAt: undefined })),
      ...secrets.map((s) => ({
        name: s.name,
        scope: s.scope,
        declared: declared.includes(s.name),
        updatedAt: s.updatedAt,
      })),
    ],
    [secrets, declared, missing],
  );
  const onDelete = useCallback(
    (name: string, scope: Scope) =>
      report(
        deleteSecret({
          params: { app, name },
          query: target(stage, scope),
          reactivityKeys: secretsChanged(app),
        }),
        `Deleted ${name}`,
      ),
    [app, stage, deleteSecret],
  );
  const tableColumns = useMemo(
    () => secretColumns(stage, del.waiting, onEdit, onDelete),
    [stage, del.waiting, onEdit, onDelete],
  );
  return (
    <div className="flex flex-col gap-4">
      {missing.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-warn-mark/40 bg-warn-mark/10 px-4 py-3 text-sm text-warn"
        >
          {stage} declares {missing.length === 1 ? 'a secret' : `${missing.length} secrets`} in{' '}
          <Mono>plat.config.ts</Mono> that {missing.length === 1 ? "isn't" : "aren't"} set:{' '}
          {missing.map((m, i) => (
            <span key={m}>
              {i > 0 && ', '}
              <Mono>{m}</Mono>
            </span>
          ))}
          .
        </div>
      )}
      <Panel flush title="Secrets" description={`What ${stage} sees: its own values and the shared ones`}>
        <DataTable
          columns={tableColumns}
          data={rows}
          getRowId={(r) => `${r.scope ?? 'missing'}:${r.name}`}
          initialSorting={[{ id: 'name', desc: false }]}
          empty={
            <EmptyState title="No secrets yet">
              Add one here, or run <Mono>plat secrets set NAME --app {app}</Mono>.
            </EmptyState>
          }
        />
      </Panel>
    </div>
  );
}

const col = columns<Row>();

/** The secrets table's columns, for the stage in view. */
function secretColumns(
  stage: string,
  busy: boolean,
  onEdit: (secret: Editing) => void,
  onDelete: (name: string, scope: Scope) => Promise<boolean>,
) {
  return col.columns([
    col.accessor('name', {
      header: 'Name',
      sortFn: 'alphanumeric',
      cell: ({ getValue }) => <Mono className="font-medium">{getValue()}</Mono>,
    }),
    col.accessor((r) => stateOf(r), {
      id: 'state',
      header: 'Status',
      cell: ({ row }) => {
        const state = STATE[stateOf(row.original)];
        return <StatusPill tone={state.tone}>{state.label}</StatusPill>;
      },
    }),
    col.accessor((r) => r.scope ?? '', {
      id: 'scope',
      header: 'Applies to',
      cell: ({ row }) =>
        row.original.scope === undefined ? (
          <span className="text-muted-foreground">–</span>
        ) : row.original.scope === 'shared' ? (
          'All stages'
        ) : (
          <>
            Only <Mono>{stage}</Mono>
          </>
        ),
    }),
    col.accessor((r) => r.updatedAt ?? '', {
      id: 'updated',
      header: 'Updated',
      meta: { numeric: true },
      cell: ({ row }) =>
        row.original.updatedAt ? (
          <span title={fmtDateTime(row.original.updatedAt)}>{relTime(row.original.updatedAt)}</span>
        ) : (
          <span className="text-muted-foreground">–</span>
        ),
    }),
    col.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: 'w-0 whitespace-nowrap text-right' },
      cell: ({ row }) => {
        const r = row.original;
        if (r.scope === undefined) {
          return (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onEdit({ name: r.name, scope: 'shared', replacing: false })}
            >
              Set
            </Button>
          );
        }
        const scope = r.scope;
        return (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onEdit({ name: r.name, scope, replacing: true })}
            >
              Replace
            </Button>
            <ConfirmAction
              trigger={<Button variant="ghost" size="icon-xs" aria-label={`Delete ${r.name}`} />}
              disabled={busy}
              title={`Delete ${r.name}?`}
              description={
                scope === 'shared'
                  ? `Every stage without its own ${r.name} loses it.`
                  : `${stage} reads the shared ${r.name} instead, if there is one.`
              }
              confirmLabel="Delete secret"
              onConfirm={() => onDelete(r.name, scope)}
            >
              <Trash2 />
            </ConfirmAction>
          </div>
        );
      },
    }),
  ]);
}

/** Sets a secret, or replaces its value; the name and scope come preset when replacing. */
function SecretDialog({
  app,
  stage,
  initial,
  onOpenChange,
}: {
  app: string;
  stage: string;
  initial: Editing | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={initial !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {initial && (
          <SecretForm
            key={`${initial.scope}:${initial.name}:${initial.replacing}`}
            app={app}
            stage={stage}
            initial={initial}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SecretForm({
  app,
  stage,
  initial,
  onDone,
}: {
  app: string;
  stage: string;
  initial: Editing;
  onDone: () => void;
}) {
  const [put, putSecret] = useAtom(putSecretAtom, { mode: 'promiseExit' });
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<Scope>(initial.scope);
  const { replacing } = initial;
  const named = initial.name !== '';
  const badName = name !== '' && !ENV_NAME_PATTERN.test(name);
  const tooLong = new TextEncoder().encode(value).length > 4096;
  const save = async () => {
    const done = await report(
      putSecret({
        params: { app, name },
        query: target(stage, scope),
        payload: { value },
        reactivityKeys: secretsChanged(app),
      }),
      `Saved ${name} for ${scope === 'shared' ? 'all stages' : stage}`,
    );
    if (done) onDone();
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name && value && !badName && !tooLong) void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {replacing ? `Replace ${initial.name}` : named ? `Set ${initial.name}` : 'Add a secret'}
        </DialogTitle>
        <DialogDescription>The value can't be read back once it's saved.</DialogDescription>
      </DialogHeader>
      {!named && (
        <Field data-invalid={badName || undefined}>
          <FieldLabel htmlFor="secret-name">Name</FieldLabel>
          <Input
            id="secret-name"
            className="font-mono"
            placeholder="STRIPE_KEY"
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            aria-invalid={badName || undefined}
          />
          {badName && (
            <FieldDescription>
              Capital letters, digits and underscores, starting with a letter; up to 64.
            </FieldDescription>
          )}
        </Field>
      )}
      <Field data-invalid={tooLong || undefined}>
        <FieldLabel htmlFor="secret-value">Value</FieldLabel>
        <Input
          id="secret-value"
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={tooLong || undefined}
        />
        {tooLong && <FieldDescription>Secret values are limited to 4 KB.</FieldDescription>}
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Applies to</FieldLegend>
        <RadioGroup
          value={scope}
          onValueChange={(v) => setScope(v as Scope)}
          disabled={replacing}
          className="gap-3"
        >
          <Field orientation="horizontal">
            <RadioGroupItem id="secret-scope-shared" value="shared" />
            <FieldLabel htmlFor="secret-scope-shared" className="font-normal">
              All stages
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id="secret-scope-stage" value="stage" />
            <FieldLabel htmlFor="secret-scope-stage" className="font-normal">
              <span>
                Only <Mono>{stage}</Mono>
                <span className="text-muted-foreground">, over a shared value of the same name</span>
              </span>
            </FieldLabel>
          </Field>
        </RadioGroup>
      </FieldSet>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={put.waiting || !name || !value || badName || tooLong}>
          {put.waiting ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
