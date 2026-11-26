/**
 * An app's record: its description, the repository CI may deploy it from,
 * and the members who own it, each saved on its own; and whether the public
 * directory lists it, which plat.config.ts decides. Deleting the app
 * removes only that record, and only once no stage is left; it asks for the
 * app's name first.
 */
import { useAtom } from '@effect/atom-react';
import { type AppSummary, REPO_PATTERN, type UpdateAppRequest } from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { type ReactElement, type ReactNode, useState } from 'react';
import { ApiClient } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { Loading, Mono, PageHeader, Panel } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field.tsx';
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
        // Keyed by app: each form starts from the record once, not on every refetch.
        <div key={app} className="flex max-w-3xl flex-col gap-5">
          <DescriptionForm summary={summary} />
          <RepositoryForm summary={summary} />
          <OwnersForm summary={summary} />
          <DirectoryPanel summary={summary} />
          <DangerZone summary={summary} />
        </div>
      ) : (
        <Loading className="max-w-3xl" />
      )}
    </>
  );
}

/** Saves one change to the app's record; resolves whether it saved. */
function useUpdate(app: string) {
  const [save, updateApp] = useAtom(updateAppAtom, { mode: 'promiseExit' });
  const update = (payload: UpdateAppRequest, what: string) =>
    report(
      updateApp({ params: { app }, payload, reactivityKeys: [...appChanged(app), ...appsChanged] }),
      `Saved ${app}'s ${what}`,
    );
  return [save.waiting, update] as const;
}

/**
 * One setting as a card: its title and what it means above the field, and
 * a band below with a note and the setting's own Save, enabled once it changes.
 */
function SettingCard({
  title,
  description,
  note,
  changed,
  invalid,
  saving,
  onSave,
  onDiscard,
  children,
}: {
  title: string;
  description: ReactNode;
  note: ReactNode;
  changed: boolean;
  invalid: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  children: ReactNode;
}) {
  return (
    <form
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !invalid) onSave();
      }}
    >
      <Panel
        footer={
          <>
            <span className="min-w-0 flex-1">{note}</span>
            {changed && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Discard ${title.toLowerCase()} changes`}
                onClick={onDiscard}
              >
                Discard
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              aria-label={`Save ${title.toLowerCase()}`}
              disabled={saving || !changed || invalid}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <Field invalid={invalid} className="gap-0">
          <h2>
            <FieldLabel className="text-base font-semibold tracking-tight select-auto">{title}</FieldLabel>
          </h2>
          <FieldDescription className="mt-1.5 mb-4 text-sm">{description}</FieldDescription>
          {children}
        </Field>
      </Panel>
    </form>
  );
}

function DescriptionForm({ summary }: { summary: AppSummary }) {
  const record = summary.app;
  const [saving, update] = useUpdate(record.name);
  const [description, setDescription] = useState(record.description ?? '');
  return (
    <SettingCard
      title="Description"
      description="What the app does, in a line. It shows under the app's name in the list of apps."
      note={`Up to ${DESCRIPTION_MAX} characters.`}
      changed={description.trim() !== (record.description ?? '')}
      invalid={false}
      saving={saving}
      onSave={() => void update({ description: description.trim() }, 'description')}
      onDiscard={() => setDescription(record.description ?? '')}
    >
      <Input
        className="max-w-xl"
        value={description}
        maxLength={DESCRIPTION_MAX}
        placeholder="What the app does, in a line"
        onValueChange={setDescription}
      />
    </SettingCard>
  );
}

function RepositoryForm({ summary }: { summary: AppSummary }) {
  const record = summary.app;
  const [saving, update] = useUpdate(record.name);
  const [repo, setRepo] = useState(record.repo);
  const bad = !REPO_PATTERN.test(repo.trim());
  return (
    <SettingCard
      title="Repository"
      description="CI deploys are accepted only from this GitHub repository, through GitHub OIDC."
      note={
        <>
          <Mono className="text-xs text-foreground">main</Mono> deploys to prod; pull requests deploy
          previews.
        </>
      }
      changed={repo.trim() !== record.repo}
      invalid={bad}
      saving={saving}
      onSave={() => void update({ repo: repo.trim() }, 'repository')}
      onDiscard={() => setRepo(record.repo)}
    >
      <Input
        className="max-w-sm font-mono text-[13px]"
        value={repo}
        spellCheck={false}
        autoComplete="off"
        placeholder="owner/name"
        onValueChange={setRepo}
      />
      {bad && (
        <FieldError match className="mt-2">
          A GitHub repository as owner/name.
        </FieldError>
      )}
    </SettingCard>
  );
}

function OwnersForm({ summary }: { summary: AppSummary }) {
  const record = summary.app;
  const [saving, update] = useUpdate(record.name);
  const [owners, setOwners] = useState(record.owners.join(', '));
  const list = ownersOf(owners);
  const none = list.length === 0;
  return (
    <SettingCard
      title="Owners"
      description="Members who can manage the app. Admins can manage every app."
      note="GitHub usernames, separated by commas."
      changed={list.join(',') !== record.owners.join(',')}
      invalid={none}
      saving={saving}
      onSave={() => void update({ owners: list }, 'owners')}
      onDiscard={() => setOwners(record.owners.join(', '))}
    >
      <Input
        className="max-w-xl"
        value={owners}
        spellCheck={false}
        autoComplete="off"
        placeholder="octocat, hubot"
        onValueChange={setOwners}
      />
      {none && (
        <FieldError match className="mt-2">
          An app needs at least one owner.
        </FieldError>
      )}
    </SettingCard>
  );
}

/** Read here, not set: plat.config.ts's `listed` decides, so it changes with a deploy. */
function DirectoryPanel({ summary }: { summary: AppSummary }) {
  const optOut = (
    <>
      <Mono className="text-foreground">listed: false</Mono> in{' '}
      <Mono className="text-foreground">plat.config.ts</Mono>
    </>
  );
  return (
    <Panel>
      <h2 className="text-base font-semibold tracking-tight">Public directory</h2>
      <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
        {summary.listed === undefined ? (
          <>Prod is listed once it's deployed, unless {optOut} keeps it out.</>
        ) : summary.listed ? (
          <>
            Listed: anyone can read prod's description, address and daily page views at{' '}
            <a className="text-foreground underline-offset-4 hover:underline" href="/v1/public/apps">
              /v1/public/apps
            </a>
            . {optOut} takes it out.
          </>
        ) : (
          <>Not listed: {optOut} keeps it out.</>
        )}
      </p>
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
    <Panel
      className="border-bad-mark/40 [&>footer]:border-bad-mark/25 [&>footer]:bg-bad-mark/6"
      footer={
        <div className="ml-auto">
          <ConfirmAction
            trigger={<Button variant="destructive" size="sm" />}
            disabled={live.length > 0 || del.waiting}
            title={`Delete ${app}?`}
            description="This removes the app's record and can't be undone. Its repository and code are untouched."
            body={
              <Field>
                <FieldLabel>
                  Type <Mono>{app}</Mono> to confirm
                </FieldLabel>
                <Input
                  className="font-mono text-[13px]"
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onValueChange={setTyped}
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
      }
    >
      <h2 className="text-base font-semibold tracking-tight">Delete app</h2>
      <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
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
            <Link
              to="/apps/$app/deployments"
              params={{ app }}
              className="text-foreground underline-offset-4 hover:underline"
            >
              Deployments
            </Link>
            ; prod with{' '}
            <Mono className="whitespace-nowrap text-foreground">plat destroy --stage prod --force</Mono>.
          </>
        ) : (
          "Removes the app's record. Its repository and code are untouched."
        )}
      </p>
    </Panel>
  );
}
