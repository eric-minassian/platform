/**
 * An app's secrets as the stage in view sees them: its own and the shared
 * ones (all stages), which of them the live deployment declares, and the
 * declared ones nobody has set. Values are write-only: add one, set or
 * replace one, or delete it after confirming; nothing ever reads a value back.
 */
import { useAtom, useAtomValue } from '@effect/atom-react';
import { ENV_NAME_PATTERN, type SecretInfo } from '@ericminassian/platform-core';
import { PasswordInput, PasswordInputControl, PasswordInputToggle } from '@ui-sdk/react/password-input';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Eye, EyeOff, MoreHorizontal, PenLine, Trash2 } from 'lucide-react';
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { report } from '../../components/actions/report.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  EmptyState,
  Loaded,
  Mono,
  Notice,
  PageHeader,
  Panel,
  StatusText,
  type Tone,
} from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu.tsx';
import { confirm } from '../../components/ui/overlays.tsx';
import { Radio, RadioGroup } from '../../components/ui/radio.tsx';
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

/** What the dialog sets: a declared secret nobody has set, or an existing value to replace. */
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

/** Secret values are limited to 4 KB. */
const tooLong = (value: string) => new TextEncoder().encode(value).length > 4096;

/** Saves a value, toasting what happened; resolves whether it saved. */
function useSave(app: string, stage: string) {
  const [put, putSecret] = useAtom(putSecretAtom, { mode: 'promiseExit' });
  const save = useCallback(
    (name: string, scope: Scope, value: string) =>
      report(
        putSecret({
          params: { app, name },
          query: target(stage, scope),
          payload: { value },
          reactivityKeys: secretsChanged(app),
        }),
        `Saved ${name} for ${scope === 'shared' ? 'all stages' : stage}`,
      ),
    [app, stage, putSecret],
  );
  return [put.waiting, save] as const;
}

export function SecretsPage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const result = useAtomValue(secretsAtom({ app, stage }));
  const missing = Option.match(AsyncResult.value(result), { onNone: () => [], onSome: (d) => d.missing });
  const [editing, setEditing] = useState<Editing | null>(null);
  return (
    <>
      <PageHeader
        title="Secrets"
        description="Write-only: a value is never shown again. Running code picks up a change within about 5 minutes."
      />
      {missing.length > 0 && (
        <Notice tone="warn">
          {stage} declares {missing.length === 1 ? 'a secret' : `${missing.length} secrets`} in{' '}
          <code>plat.config.ts</code> that {missing.length === 1 ? "isn't" : "aren't"} set:{' '}
          {missing.map((m, i) => (
            <span key={m}>
              {i > 0 && ', '}
              <code>{m}</code>
            </span>
          ))}
          .
        </Notice>
      )}
      <AddSecret app={app} stage={stage} />
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

/** A secret's value: masked as it's typed, with a button that shows it. */
function ValueInput({
  value,
  onValueChange,
  placeholder,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <PasswordInput
      value={value}
      onValueChange={(v) => onValueChange(v)}
      autoComplete="new-password"
      className="flex h-8 w-full min-w-0 items-center gap-1 rounded-md border border-input bg-background pr-1 pl-2.5 transition-[border-color,box-shadow] hover:border-border-strong has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/20 has-[input[aria-invalid=true]]:border-destructive"
    >
      <PasswordInputControl
        placeholder={placeholder}
        spellCheck={false}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] text-foreground outline-hidden placeholder:font-sans placeholder:text-sm placeholder:text-subtle"
      />
      <PasswordInputToggle
        aria-label="Show value"
        className="grid size-6 shrink-0 cursor-default place-items-center rounded-[5px] text-subtle outline-hidden hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
      >
        {(state) =>
          state.visible ? (
            <EyeOff aria-hidden className="size-3.5" />
          ) : (
            <Eye aria-hidden className="size-3.5" />
          )
        }
      </PasswordInputToggle>
    </PasswordInput>
  );
}

function ScopeChoice({
  stage,
  value,
  onChange,
}: {
  stage: string;
  value: Scope;
  onChange: (scope: Scope) => void;
}) {
  return (
    <Field>
      <FieldLabel>Applies to</FieldLabel>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as Scope)}
        className="flex-row flex-wrap gap-x-6 gap-y-2 py-1"
      >
        <Label className="text-sm font-normal">
          <Radio value="shared" />
          All stages
        </Label>
        <Label className="text-sm font-normal">
          <Radio value="stage" />
          <span>
            Only <Mono>{stage}</Mono>
          </span>
        </Label>
      </RadioGroup>
      <FieldDescription>
        A value for only <code>{stage}</code> takes the place of a shared one with the same name.
      </FieldDescription>
    </Field>
  );
}

/** The form at the top of the page, for a secret by any name. */
function AddSecret({ app, stage }: { app: string; stage: string }) {
  const [saving, save] = useSave(app, stage);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<Scope>('shared');
  const badName = name !== '' && !ENV_NAME_PATTERN.test(name);
  const big = tooLong(value);
  const ready = name !== '' && value !== '' && !badName && !big;
  const add = async () => {
    if (!(await save(name, scope, value))) return;
    setName('');
    setValue('');
  };
  return (
    <form
      aria-label="Add secret"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void add();
      }}
    >
      <Panel
        title="Add secret"
        bodyClassName="flex flex-col gap-5"
        footer={
          <>
            <span className="min-w-0 flex-1">
              Or from a terminal:{' '}
              <Mono className="text-xs text-foreground">plat secrets set NAME --app {app}</Mono>
            </span>
            <Button type="submit" size="sm" disabled={saving || !ready}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field invalid={badName}>
            <FieldLabel>Name</FieldLabel>
            <Input
              className="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
              placeholder="e.g. STRIPE_KEY"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onValueChange={(v) => setName(v.toUpperCase())}
            />
            {badName && (
              <FieldError match>
                Capital letters, digits and underscores, starting with a letter; up to 64.
              </FieldError>
            )}
          </Field>
          <Field invalid={big}>
            <FieldLabel>Value</FieldLabel>
            <ValueInput value={value} onValueChange={setValue} />
            {big && <FieldError match>Secret values are limited to 4 KB.</FieldError>}
          </Field>
        </div>
        <ScopeChoice stage={stage} value={scope} onChange={setScope} />
      </Panel>
    </form>
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
    async (name: string, scope: Scope) => {
      const sure = await confirm({
        title: `Delete ${name}?`,
        description:
          scope === 'shared'
            ? `Every stage without its own ${name} loses it.`
            : `${stage} reads the shared ${name} instead, if there is one.`,
        confirmLabel: 'Delete secret',
        destructive: true,
      });
      if (!sure) return;
      await report(
        deleteSecret({
          params: { app, name },
          query: target(stage, scope),
          reactivityKeys: secretsChanged(app),
        }),
        `Deleted ${name}`,
      );
    },
    [app, stage, deleteSecret],
  );
  const tableColumns = useMemo(
    () => secretColumns(stage, del.waiting, onEdit, onDelete),
    [stage, del.waiting, onEdit, onDelete],
  );
  return (
    <Panel flush title="Secrets" description={`What ${stage} sees: its own values and the shared ones`}>
      <DataTable
        columns={tableColumns}
        data={rows}
        getRowId={(r) => `${r.scope ?? 'missing'}:${r.name}`}
        initialSorting={[{ id: 'name', desc: false }]}
        empty={<EmptyState title="No secrets yet">Add one above.</EmptyState>}
      />
    </Panel>
  );
}

const col = columns<Row>();

/** The secrets table's columns, for the stage in view. */
function secretColumns(
  stage: string,
  busy: boolean,
  onEdit: (secret: Editing) => void,
  onDelete: (name: string, scope: Scope) => Promise<void>,
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
        return <StatusText tone={state.tone}>{state.label}</StatusText>;
      },
    }),
    col.accessor((r) => r.scope ?? '', {
      id: 'scope',
      header: 'Applies to',
      cell: ({ row }) =>
        row.original.scope === undefined ? (
          <span className="text-subtle">–</span>
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
          <span className="text-muted-foreground" title={fmtDateTime(row.original.updatedAt)}>
            {relTime(row.original.updatedAt)}
          </span>
        ) : (
          <span className="text-subtle">–</span>
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
              size="sm"
              aria-label={`Set ${r.name}`}
              onClick={() => onEdit({ name: r.name, scope: 'shared', replacing: false })}
            >
              Set
            </Button>
          );
        }
        const scope = r.scope;
        return (
          <Menu
            onAction={(action) => {
              if (action === 'replace') onEdit({ name: r.name, scope, replacing: true });
              else if (action === 'delete') void onDelete(r.name, scope);
            }}
          >
            <MenuTrigger
              disabled={busy}
              render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`} />}
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent align="end" className="w-48">
              <MenuItem value="replace">
                <PenLine />
                Replace value
              </MenuItem>
              <MenuSeparator />
              <MenuItem value="delete" destructive>
                <Trash2 />
                Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        );
      },
    }),
  ]);
}

/** Sets a declared secret or replaces a value; the name, and the scope of a value, come preset. */
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
  // What the dialog shows stays while it fades out.
  const [kept, setKept] = useState(initial);
  if (initial && initial !== kept) setKept(initial);
  const shown = initial ?? kept;
  return (
    <Dialog open={initial !== null} onOpenChange={onOpenChange}>
      <DialogContent width="28rem">
        {shown && (
          <SecretForm
            key={`${shown.scope}:${shown.name}:${shown.replacing}`}
            app={app}
            stage={stage}
            initial={shown}
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
  const [saving, save] = useSave(app, stage);
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<Scope>(initial.scope);
  const { name, replacing } = initial;
  const big = tooLong(value);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value || big) return;
        void save(name, scope, value).then((done) => done && onDone());
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {replacing ? 'Replace' : 'Set'} <Mono className="text-base">{name}</Mono>
        </DialogTitle>
        <DialogDescription>
          {replacing && `Applies to ${scope === 'shared' ? 'all stages' : `only ${stage}`}. `}
          The value can&apos;t be read back once it&apos;s saved.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        <Field invalid={big}>
          <FieldLabel>Value</FieldLabel>
          <ValueInput value={value} onValueChange={setValue} />
          {big && <FieldError match>Secret values are limited to 4 KB.</FieldError>}
        </Field>
        {!replacing && <ScopeChoice stage={stage} value={scope} onChange={setScope} />}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !value || big}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
