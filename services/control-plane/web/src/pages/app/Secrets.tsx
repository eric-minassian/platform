import { useAtom, useAtomValue } from '@effect/atom-react';
import { Exit } from 'effect';
import { Atom } from 'effect/reactivity';
import { useState } from 'react';
import { ApiClient, failure, fresh, timeToLive } from '../../client.ts';
import { Badge, Button, Card, ErrorBox, Input, Loaded, Mono, Select, Table } from '../../components/ui.tsx';
import { relTime } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

/** Reactivity key of an app's secrets, on every stage. */
const secretsChanged = (app: string) => [`secrets:${app}`];

const secretsAtom = Atom.family(({ app, stage }: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('manage', 'secrets', {
      params: { app },
      query: { stage },
      reactivityKeys: secretsChanged(app),
      timeToLive,
    }),
  ),
);
const putSecretAtom = ApiClient.mutation('manage', 'putSecret');
const deleteSecretAtom = ApiClient.mutation('manage', 'deleteSecret');

export function SecretsTab() {
  const { app, scope } = useApp();
  const result = useAtomValue(secretsAtom({ app, stage: scope.stage }));
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [scopeSel, setScopeSel] = useState<'stage' | 'shared'>('shared');
  const [put, putSecret] = useAtom(putSecretAtom, { mode: 'promiseExit' });
  const [del, deleteSecret] = useAtom(deleteSecretAtom);
  // Without `scope`, the server targets the stage's own secret.
  const target = (shared: boolean) => ({
    stage: scope.stage,
    scope: shared ? ('shared' as const) : undefined,
  });
  const save = async () => {
    const exit = await putSecret({
      params: { app, name: name.trim() },
      query: target(scopeSel === 'shared'),
      payload: { value },
      reactivityKeys: secretsChanged(app),
    });
    if (Exit.isSuccess(exit)) {
      setName('');
      setValue('');
    }
  };

  return (
    <div className="space-y-3">
      <Card title="Secrets">
        <Loaded result={result}>
          {(d) => (
            <>
              {d.missing.length > 0 && (
                <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
                  Declared in plat.config.ts but not set:{' '}
                  {d.missing.map((m) => (
                    <Mono key={m} className="mr-2">
                      {m}
                    </Mono>
                  ))}
                </div>
              )}
              <Table head={['Name', 'Scope', 'Updated', '']} empty="No secrets set.">
                {d.secrets.map((s) => (
                  <tr key={`${s.scope}:${s.name}`}>
                    <td>
                      <Mono>{s.name}</Mono>
                    </td>
                    <td>
                      <Badge tone={s.scope === 'stage' ? 'info' : 'muted'}>
                        {s.scope === 'stage' ? s.stage : 'all stages'}
                      </Badge>
                    </td>
                    <td>{relTime(s.updatedAt)}</td>
                    <td className="text-right">
                      <Button
                        variant="danger"
                        onClick={() =>
                          deleteSecret({
                            params: { app, name: s.name },
                            query: target(s.scope === 'shared'),
                            reactivityKeys: secretsChanged(app),
                          })
                        }
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </Loaded>
      </Card>
      <Card title="Set a secret">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && value) void save();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="STRIPE_KEY"
            className="w-48 font-mono"
          />
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            type="password"
            className="w-72"
          />
          <Select
            value={scopeSel}
            onChange={(v) => setScopeSel(v as 'stage' | 'shared')}
            options={[
              { value: 'shared', label: 'all stages' },
              { value: 'stage', label: `only ${scope.stage}` },
            ]}
          />
          <Button type="submit" variant="primary" disabled={put.waiting}>
            Save
          </Button>
        </form>
        <ErrorBox error={failure(put) ?? failure(del)} />
        <p className="pt-2 text-[11px] text-muted">
          Values are write-only and reach running code within ~5 minutes. CLI:{' '}
          <Mono>plat secrets set {app} NAME</Mono>
        </p>
      </Card>
    </div>
  );
}
