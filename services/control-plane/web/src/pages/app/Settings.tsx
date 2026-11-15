import { useAtom } from '@effect/atom-react';
import { Exit } from 'effect';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiClient, failure, succeeded } from '../../client.ts';
import { Button, Card, ErrorBox, Input, Mono } from '../../components/ui.tsx';
import { appChanged, useApp } from '../AppLayout.tsx';
import { appsChanged } from '../Apps.tsx';

const updateAppAtom = ApiClient.mutation('apps', 'update');
const removeAppAtom = ApiClient.mutation('apps', 'remove');

export function SettingsTab() {
  const { app, summary } = useApp();
  const navigate = useNavigate();
  const [repo, setRepo] = useState(summary.app.repo);
  const [owners, setOwners] = useState(summary.app.owners.join(', '));
  const [description, setDescription] = useState(summary.app.description ?? '');
  const [save, updateApp] = useAtom(updateAppAtom);
  const [del, removeApp] = useAtom(removeAppAtom, { mode: 'promiseExit' });
  const live = summary.stages.filter((s) => s.status !== 'destroyed');
  const deleteApp = async () => {
    if (Exit.isSuccess(await removeApp({ params: { app }, reactivityKeys: appsChanged })))
      await navigate('/');
  };

  return (
    <div className="max-w-2xl space-y-3">
      <Card title="App">
        <form
          className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            updateApp({
              params: { app },
              payload: {
                repo: repo.trim(),
                description: description.trim(),
                owners: owners
                  .split(',')
                  .map((o) => o.trim())
                  .filter(Boolean),
              },
              reactivityKeys: appChanged(app),
            });
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
            <Button type="submit" variant="primary" disabled={save.waiting}>
              Save
            </Button>
            {succeeded(save) && <span className="text-[12px] text-ok">Saved</span>}
          </div>
        </form>
        <ErrorBox error={failure(save)} />
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
        <Button variant="danger" disabled={live.length > 0 || del.waiting} onClick={() => void deleteApp()}>
          Delete app
        </Button>
        <ErrorBox error={failure(del)} />
      </Card>
    </div>
  );
}
