import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api.ts';
import { Badge, Button, Card, ErrorBox, Input, Loaded, Mono, Select, Table } from '../../components/ui.tsx';
import { relTime } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

export function SecretsTab() {
  const { app, scope } = useApp();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['secrets', app, scope.stage],
    queryFn: () => api.secrets(app, scope.stage),
  });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [scopeSel, setScopeSel] = useState<'stage' | 'shared'>('shared');
  const refresh = () => qc.invalidateQueries({ queryKey: ['secrets', app] });
  const put = useMutation({
    mutationFn: () => api.putSecret(app, scope.stage, name.trim(), value, scopeSel === 'shared'),
    onSuccess: () => {
      setName('');
      setValue('');
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (s: { name: string; shared: boolean }) =>
      api.deleteSecret(app, scope.stage, s.name, s.shared),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-3">
      <Card title="Secrets">
        <Loaded q={q}>
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
                        onClick={() => del.mutate({ name: s.name, shared: s.scope === 'shared' })}
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
            if (name.trim() && value) put.mutate();
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
          <Button type="submit" variant="primary" disabled={put.isPending}>
            Save
          </Button>
        </form>
        <ErrorBox error={put.error ?? del.error} />
        <p className="pt-2 text-[11px] text-muted">
          Values are write-only and reach running code within ~5 minutes. CLI:{' '}
          <Mono>plat secrets set {app} NAME</Mono>
        </p>
      </Card>
    </div>
  );
}
