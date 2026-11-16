/**
 * An app's record: its description, the repository CI may deploy it from,
 * and the members who own it. Deleting the app removes only that record,
 * and only once no stage is left; it asks for the app's name first.
 */
import { useAtom } from '@effect/atom-react';
import { type AppSummary, REPO_PATTERN } from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { type ReactElement, useState } from 'react';
import { ApiClient } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { Loading, Mono, PageHeader, Panel } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../components/ui/field.tsx';
import { Input } from '../../components/ui/input.tsx';
import { appChanged, appsChanged } from '../../data/atoms.ts';
import { useAppSummary } from '../../data/hooks.ts';
import { appRoute } from '../../router.tsx';

const updateAppAtom = ApiClient.mutation('apps', 'update');
const removeAppAtom = ApiClient.mutation('apps', 'remove');

/** The server cuts longer descriptions to this length. */
const DESCRIPTION_MAX = 200;

const ownersOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/^@/, ''))
    .filter(Boolean);

export function SettingsPage(): ReactElement {
  const { app } = appRoute.useParams();
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  return (
    <>
      <PageHeader
        title="Settings"
        description={`The record of ${app}: what it is, where it deploys from, who owns it.`}
      />
      {summary ? (
        <div className="flex max-w-3xl flex-col gap-4">
          {/* Keyed by app: the form starts from the record once, not on every refetch. */}
          <AppForm key={app} summary={summary} />
          <DangerZone summary={summary} />
        </div>
      ) : (
        <Loading className="max-w-3xl" />
      )}
    </>
  );
}

function AppForm({ summary }: { summary: AppSummary }) {
  const record = summary.app;
  const app = record.name;
  const [save, updateApp] = useAtom(updateAppAtom, { mode: 'promiseExit' });
  const [description, setDescription] = useState(record.description ?? '');
  const [repo, setRepo] = useState(record.repo);
  const [owners, setOwners] = useState(record.owners.join(', '));
  const badRepo = !REPO_PATTERN.test(repo.trim());
  const ownerList = ownersOf(owners);
  const noOwners = ownerList.length === 0;
  const changed =
    description.trim() !== (record.description ?? '') ||
    repo.trim() !== record.repo ||
    ownerList.join(',') !== record.owners.join(',');
  return (
    <Panel title="App">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (badRepo || noOwners) return;
          void report(
            updateApp({
              params: { app },
              payload: { repo: repo.trim(), description: description.trim(), owners: ownerList },
              reactivityKeys: [...appChanged(app), ...appsChanged],
            }),
            `Saved ${app}`,
          );
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="app-description">Description</FieldLabel>
            <Input
              id="app-description"
              value={description}
              maxLength={DESCRIPTION_MAX}
              placeholder="What the app does, in a line"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field data-invalid={badRepo || undefined}>
            <FieldLabel htmlFor="app-repo">Repository</FieldLabel>
            <Input
              id="app-repo"
              className="font-mono"
              value={repo}
              spellCheck={false}
              placeholder="owner/name"
              onChange={(e) => setRepo(e.target.value)}
              aria-invalid={badRepo || undefined}
            />
            <FieldDescription>
              {badRepo ? (
                'A GitHub repository as owner/name.'
              ) : (
                <>
                  CI deploys are accepted only from this repository (GitHub OIDC):{' '}
                  <Mono className="text-xs">main</Mono> to prod, pull requests to previews.
                </>
              )}
            </FieldDescription>
          </Field>
          <Field data-invalid={noOwners || undefined}>
            <FieldLabel htmlFor="app-owners">Owners</FieldLabel>
            <Input
              id="app-owners"
              value={owners}
              spellCheck={false}
              placeholder="GitHub usernames, comma separated"
              onChange={(e) => setOwners(e.target.value)}
              aria-invalid={noOwners || undefined}
            />
            <FieldDescription>
              {noOwners
                ? 'An app needs at least one owner.'
                : 'Members who can manage the app. Admins can manage every app.'}
            </FieldDescription>
          </Field>
        </FieldGroup>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.waiting || !changed || badRepo || noOwners}>
            {save.waiting ? 'Saving…' : 'Save'}
          </Button>
          {changed && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDescription(record.description ?? '');
                setRepo(record.repo);
                setOwners(record.owners.join(', '));
              }}
            >
              Discard changes
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

function DangerZone({ summary }: { summary: AppSummary }) {
  const app = summary.app.name;
  const navigate = useNavigate();
  const [del, removeApp] = useAtom(removeAppAtom, { mode: 'promiseExit' });
  const [typed, setTyped] = useState('');
  const live = summary.stages.filter((s) => s.status !== 'destroyed');
  return (
    <Panel title="Delete app" className="border-bad-mark/40">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1 text-sm text-muted-foreground">
          {live.length ? (
            <>
              Destroy its stages first:{' '}
              {live.map((s, i) => (
                <span key={s.stage}>
                  {i > 0 && ', '}
                  <Mono className="text-foreground">{s.stage}</Mono>
                </span>
              ))}
              . Previews can be destroyed on{' '}
              <Link to="/apps/$app/deployments" params={{ app }} className="text-foreground hover:underline">
                Deployments
              </Link>
              ; prod with <Mono>plat destroy --stage prod --force</Mono>.
            </>
          ) : (
            "Removes the app's record. Its repository and code are untouched."
          )}
        </div>
        <ConfirmAction
          trigger={<Button variant="destructive" />}
          disabled={live.length > 0 || del.waiting}
          title={`Delete ${app}?`}
          description="This removes the app's record and can't be undone. Its repository and code are untouched."
          body={
            <Field>
              <FieldLabel htmlFor="delete-app-name">
                Type <Mono>{app}</Mono> to confirm
              </FieldLabel>
              <Input
                id="delete-app-name"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </Field>
          }
          canConfirm={typed === app}
          confirmLabel="Delete app"
          onOpenChange={(open) => !open && setTyped('')}
          onConfirm={async () => {
            const done = await report(
              removeApp({ params: { app }, reactivityKeys: appsChanged }),
              `Deleted ${app}`,
            );
            if (done) await navigate({ to: '/' });
            return done;
          }}
        >
          Delete app
        </ConfirmAction>
      </div>
    </Panel>
  );
}
