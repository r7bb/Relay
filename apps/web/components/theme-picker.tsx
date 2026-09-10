'use client';

import { THEME_LIST, type ThemeId } from '@relay/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { rememberTheme } from '../lib/theme.ts';

/**
 * Theme switcher for a workspace.
 *
 * The theme is a property of the workspace, not of the viewer, so everyone in
 * it sees the same thing and it needs `workspace:update` to change -- the same
 * permission as renaming. A per-person preference would be a different feature
 * and a different column.
 */
export function ThemePicker({
  workspaceId,
  current,
  canEdit,
}: {
  workspaceId: string;
  current: ThemeId;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();

  const setTheme = useMutation({
    mutationFn: (theme: ThemeId) =>
      api<{ workspace: { theme: ThemeId } }>(`/workspaces/${workspaceId}`, {
        method: 'PATCH',
        body: { theme },
      }),
    // Paint immediately; the refetch below only confirms it.
    onMutate: (theme) => rememberTheme(theme),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });

  if (!canEdit) return null;

  return (
    <fieldset className="mt-12">
      <legend className="text-sm font-medium uppercase tracking-wide text-faint">Theme</legend>

      <div className="mt-3 flex flex-wrap gap-2">
        {THEME_LIST.map((theme) => {
          const active = theme.id === current;

          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => setTheme.mutate(theme.id)}
              aria-pressed={active}
              className={[
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition',
                active
                  ? 'border-accent text-content'
                  : 'border-line text-muted hover:border-faint hover:text-content',
              ].join(' ')}
            >
              <span
                aria-hidden
                className="h-4 w-4 rounded-full ring-1 ring-black/20"
                style={{ backgroundColor: theme.swatch }}
              />
              {theme.label}
            </button>
          );
        })}
      </div>

      {setTheme.isError && (
        <p role="alert" className="mt-2 text-sm text-danger-soft">
          {(setTheme.error as Error).message}
        </p>
      )}
    </fieldset>
  );
}
