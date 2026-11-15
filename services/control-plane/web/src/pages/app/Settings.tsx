import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api.ts';
import { Button, Card, ErrorBox, Input, Mono } from '../../components/ui.tsx';
import { useApp } from '../AppLayout.tsx';

export function SettingsTab() {
  const { app, summary } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [repo, setRepo] = useState(summary.app.repo);
  const [owners, setOwners] = useState(summary.app.owners.join(', '));
  const [description, setDescription] = useState(summary.app.description ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.updateApp(app, {
        repo: repo.trim(),
        description: description.trim(),
        owners: owners
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app', app] }),
  });
  const del = useMutation({
    mutationFn: () => api.deleteApp(app),
    onSuccess: () => navigate('/'),
  });
  const live = summary.stages.filter((s) => s.status !== 'destroyed');

  return (
    <div className="max-w-2xl space-y-3">
      <Card title="App">
        <form
          className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label htmlFor="repo" className="text-muted">
            Repository
          </label>
          <Input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <label htmlFor="owners" className="text-muted">
            Owners
          </label>
          <Input
            id="owners"
            value={owners}
            onChange={(e) => setOwners(e.target.value)}
            placeholder="github usernames, comma separated"
          />
          <label htmlFor="desc" className="text-muted">
            Description
          </label>
          <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div />
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Save
            </Button>
            {save.isSuccess && <span className="text-[12px] text-ok">Saved</span>}
          </div>
        </form>
        <ErrorBox error={save.error} />
        <p className="pt-3 text-[11px] text-muted">
          CI deploys are accepted only from <Mono>{summary.app.repo}</Mono> (GitHub OIDC): <Mono>main</Mono> →
          prod, pull requests → previews.
        </p>
      </Card>
      <Card title="Danger zone">
        <p className="mb-2 text-[12px] text-muted">
          {live.length
            ? `Destroy these stages first (Deployments tab): ${live.map((s) => s.stage).join(', ')}.`
            : 'Removes the app record. Its repo and code are untouched.'}
        </p>
        <Button variant="danger" disabled={live.length > 0 || del.isPending} onClick={() => del.mutate()}>
          Delete app
        </Button>
        <ErrorBox error={del.error} />
      </Card>
    </div>
  );
}
