/**
 * Saved views of an app's metrics, logs or traces: open one, save the
 * current view as new or over the open one, delete. Shared with everyone
 * who can see the app.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { QueryView, SavedQuery } from '@ericminassian/platform-core';
import { Exit, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Bookmark, ChevronDown, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiClient, errorMessage } from '../client.ts';
import { queriesChanged, savedQueriesAtom } from '../data/atoms.ts';
import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';
import { Field, FieldLabel } from './ui/field.tsx';
import { Input } from './ui/input.tsx';

const createQuery = ApiClient.mutation('queries', 'create');
const updateQuery = ApiClient.mutation('queries', 'update');
const removeQuery = ApiClient.mutation('queries', 'remove');

/** The app's saved views of one kind. */
export function useSavedViews(app: string, kind: QueryView['kind']): readonly SavedQuery[] {
  const all = Option.getOrElse(
    AsyncResult.value(useAtomValue(savedQueriesAtom(app))),
    (): readonly SavedQuery[] => [],
  );
  return all.filter((q) => q.view.kind === kind);
}

export function SavedViews({
  app,
  stage,
  kind,
  view,
  range,
  currentId,
  onOpen,
  onSaved,
}: {
  app: string;
  stage: string;
  kind: QueryView['kind'];
  view: QueryView;
  /** The relative range the view opens with, if the page is on one. */
  range: string | undefined;
  currentId: string | undefined;
  onOpen: (q: SavedQuery) => void;
  onSaved: (q: SavedQuery) => void;
}) {
  const saved = useSavedViews(app, kind);
  const current = saved.find((q) => q.id === currentId);
  const [mode, setMode] = useState<'new' | 'update' | null>(null);
  const remove = useAtomSet(removeQuery, { mode: 'promiseExit' });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <Bookmark />
          {current ? <span className="max-w-40 truncate">{current.name}</span> : 'Saved views'}
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>
            {saved.length ? `${app}'s saved ${kind} views` : `No saved ${kind} views yet`}
          </DropdownMenuLabel>
          {saved.map((q) => (
            <DropdownMenuItem key={q.id} onClick={() => onOpen(q)} className="justify-between">
              <span className="truncate">{q.name}</span>
              {q.range && <span className="font-mono text-xs text-muted-foreground">{q.range}</span>}
            </DropdownMenuItem>
          ))}
          {current && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  void (async () => {
                    const exit = await remove({
                      params: { app, id: current.id },
                      reactivityKeys: queriesChanged(app),
                    });
                    if (Exit.isFailure(exit)) toast.error(errorMessage(exit.cause));
                    else toast.success(`Deleted ${current.name}`);
                  })()
                }
              >
                <Trash2 />
                Delete {current.name}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {current ? (
        <div className="flex">
          <Button size="sm" className="rounded-r-none" onClick={() => setMode('update')}>
            <Save />
            Save
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="sm"
                  className="-ml-px rounded-l-none border-l-primary-foreground/20 px-1.5"
                  aria-label="More ways to save"
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setMode('new')}>Save as a new view</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <Button size="sm" onClick={() => setMode('new')}>
          <Save />
          Save view
        </Button>
      )}
      <SaveDialog
        app={app}
        stage={stage}
        mode={mode}
        current={current}
        view={view}
        range={range}
        onClose={() => setMode(null)}
        onSaved={onSaved}
      />
    </>
  );
}

function SaveDialog({
  app,
  stage,
  mode,
  current,
  view,
  range,
  onClose,
  onSaved,
}: {
  app: string;
  stage: string;
  mode: 'new' | 'update' | null;
  current: SavedQuery | undefined;
  view: QueryView;
  range: string | undefined;
  onClose: () => void;
  onSaved: (q: SavedQuery) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = useAtomSet(createQuery, { mode: 'promiseExit' });
  const update = useAtomSet(updateQuery, { mode: 'promiseExit' });
  const updating = mode === 'update' && current;
  const save = async () => {
    setBusy(true);
    const payload = {
      name: updating ? current.name : name.trim(),
      view,
      ...(range ? { range } : {}),
      ...(stage !== 'prod' ? { stage } : {}),
    };
    const exit = updating
      ? await update({ params: { app, id: current.id }, payload, reactivityKeys: queriesChanged(app) })
      : await create({ params: { app }, payload, reactivityKeys: queriesChanged(app) });
    setBusy(false);
    if (Exit.isFailure(exit)) {
      toast.error(errorMessage(exit.cause));
      return;
    }
    toast.success(`Saved ${exit.value.name}`);
    setName('');
    onSaved(exit.value);
    onClose();
  };
  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{updating ? `Save ${current.name}` : 'Save this view'}</DialogTitle>
          <DialogDescription>
            Everyone who can see {app} can open it.{range ? ` It opens on the last ${range}.` : ''}
          </DialogDescription>
        </DialogHeader>
        {!updating && (
          <Field>
            <FieldLabel htmlFor="saved-view-name">Name</FieldLabel>
            <Input
              id="saved-view-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()}
            />
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || (!updating && !name.trim())} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
