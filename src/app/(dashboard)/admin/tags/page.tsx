'use client';

/**
 * Tags management page - create, edit, delete tags and rules
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tag, Plus, Pencil, Trash2, Save, X, ChevronDown, ChevronUp } from 'lucide-react';

interface TagData {
  id: string;
  name: string;
  color: string;
  threadCount: number;
  ruleCount: number;
}

interface TagRule {
  id: string;
  tagId: string;
  condition: string;
  value: string;
  enabled: boolean;
}

const TAG_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#6b7280', // gray
];

const CONDITION_LABELS: Record<string, string> = {
  SUBJECT_CONTAINS: 'Subject line contains',
  SUBJECT_STARTS_WITH: 'Subject line starts with',
  EMAIL_CONTAINS: 'Sender email address contains',
  EMAIL_DOMAIN: 'Sender email domain is',
  BODY_CONTAINS: 'Message body contains',
};

export default function TagsPage() {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3b82f6');
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [expandedTag, setExpandedTag] = useState<string | null>(null);

  // Rule creation state
  const [newRuleCondition, setNewRuleCondition] = useState('SUBJECT_CONTAINS');
  const [newRuleValue, setNewRuleValue] = useState('');

  const { data: tags, isLoading } = useQuery<TagData[]>({
    queryKey: ['tags'],
    queryFn: async () => {
      const res = await fetch('/api/tags');
      if (!res.ok) throw new Error('Failed to fetch tags');
      return res.json();
    },
    staleTime: 30000, // Cache for 30 seconds
  });

  // Fetch rules for expanded tag
  const { data: tagRules } = useQuery<TagRule[]>({
    queryKey: ['tag-rules', expandedTag],
    queryFn: async () => {
      if (!expandedTag) return [];
      const res = await fetch(`/api/tags/${expandedTag}`);
      if (!res.ok) return [];
      const tag = await res.json();
      return tag.rules || [];
    },
    enabled: !!expandedTag,
    staleTime: 30000, // Cache for 30 seconds
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; color: string }) => {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create tag');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setShowCreateForm(false);
      setNewTagName('');
      setNewTagColor('#3b82f6');
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; color?: string } }) => {
      const res = await fetch(`/api/tags/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update tag');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setEditingTag(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/tags/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete tag');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
    },
  });

  const createRuleMutation = useMutation({
    mutationFn: async (data: { tagId: string; condition: string; value: string }) => {
      const res = await fetch('/api/tag-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-rules', expandedTag] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setNewRuleValue('');
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/tag-rules/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-rules', expandedTag] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
    },
  });

  const startEdit = (tag: TagData) => {
    setEditingTag(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color);
  };

  const handleCreate = () => {
    if (!newTagName.trim()) return;
    createMutation.mutate({ name: newTagName.trim(), color: newTagColor });
  };

  const handleUpdate = (id: string) => {
    if (!editName.trim()) return;
    updateMutation.mutate({ id, data: { name: editName.trim(), color: editColor } });
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Delete tag "${name}"? This will remove it from all threads.`)) {
      deleteMutation.mutate(id);
    }
  };

  const handleCreateRule = () => {
    if (!newRuleValue.trim() || !expandedTag) return;
    createRuleMutation.mutate({
      tagId: expandedTag,
      condition: newRuleCondition,
      value: newRuleValue.trim(),
    });
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4" />
          <div className="h-12 bg-gray-200 rounded" />
          <div className="h-12 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tags</h1>
          <p className="text-sm text-gray-900">Manage tags and auto-tagging rules</p>
        </div>
        {!showCreateForm && (
          <Button onClick={() => setShowCreateForm(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Tag
          </Button>
        )}
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div className="bg-white rounded-lg border p-4 mb-4">
          <h3 className="font-medium text-gray-900 mb-3">Create New Tag</h3>
          <div className="flex items-center gap-3">
            <Input
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="Tag name"
              className="flex-1"
            />
            <div className="flex items-center gap-1">
              {TAG_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setNewTagColor(color)}
                  className={`w-6 h-6 rounded-full border-2 ${
                    newTagColor === color ? 'border-gray-900' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            <Button
              onClick={handleCreate}
              loading={createMutation.isPending}
              disabled={!newTagName.trim() || createMutation.isPending}
            >
              <Save className="w-4 h-4 mr-1" />
              Create
            </Button>
            <Button variant="secondary" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
          </div>
          {createMutation.error && (
            <p className="mt-2 text-sm text-red-500">{createMutation.error.message}</p>
          )}
        </div>
      )}

      {/* Tags list */}
      <div className="space-y-2">
        {tags?.map((tag) => (
          <div key={tag.id} className="bg-white rounded-lg border overflow-hidden">
            {editingTag === tag.id ? (
              <div className="p-4 flex items-center gap-3">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="flex-1"
                />
                <div className="flex items-center gap-1">
                  {TAG_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setEditColor(color)}
                      className={`w-6 h-6 rounded-full border-2 ${
                        editColor === color ? 'border-gray-900' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
                <Button
                  size="sm"
                  onClick={() => handleUpdate(tag.id)}
                  loading={updateMutation.isPending}
                >
                  Save
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditingTag(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <div
                  className="p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50"
                  onClick={() => setExpandedTag(expandedTag === tag.id ? null : tag.id)}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="font-medium text-gray-900">{tag.name}</span>
                    <span className="text-sm text-gray-900">
                      {tag.threadCount} thread{tag.threadCount !== 1 ? 's' : ''}
                    </span>
                    {tag.ruleCount > 0 && (
                      <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">
                        {tag.ruleCount} rule{tag.ruleCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(tag);
                      }}
                      className="p-1 text-gray-400 hover:text-gray-600"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(tag.id, tag.name);
                      }}
                      className="p-1 text-gray-400 hover:text-red-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {expandedTag === tag.id ? (
                      <ChevronUp className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                </div>

                {/* Expanded rules section */}
                {expandedTag === tag.id && (
                  <div className="border-t bg-gray-50 p-4">
                    <h4 className="font-medium text-gray-900 mb-3">Auto-tagging Rules</h4>
                    <p className="text-sm text-gray-900 mb-4">
                      Threads matching these rules will automatically receive this tag.
                    </p>

                    {/* Existing rules */}
                    {tagRules && tagRules.length > 0 ? (
                      <div className="space-y-2 mb-4">
                        {tagRules.map((rule) => (
                          <div
                            key={rule.id}
                            className="flex items-center justify-between bg-white px-3 py-2 rounded border"
                          >
                            <span className="text-sm text-gray-900">
                              <span className="font-medium text-gray-900">{CONDITION_LABELS[rule.condition]}</span>
                              {' "'}
                              <span className="text-blue-600 font-medium">{rule.value}</span>
                              {'"'}
                            </span>
                            <button
                              onClick={() => deleteRuleMutation.mutate(rule.id)}
                              className="p-1 text-gray-400 hover:text-red-600"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-900 mb-4">No rules configured yet.</p>
                    )}

                    {/* Add new rule */}
                    <div className="flex items-center gap-2">
                      <select
                        value={newRuleCondition}
                        onChange={(e) => setNewRuleCondition(e.target.value)}
                        className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900"
                      >
                        {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <Input
                        value={newRuleValue}
                        onChange={(e) => setNewRuleValue(e.target.value)}
                        placeholder="Value to match"
                        className="flex-1"
                      />
                      <Button
                        size="sm"
                        onClick={handleCreateRule}
                        loading={createRuleMutation.isPending}
                        disabled={!newRuleValue.trim() || createRuleMutation.isPending}
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        Add Rule
                      </Button>
                    </div>
                    {(newRuleCondition === 'SUBJECT_CONTAINS' || newRuleCondition === 'BODY_CONTAINS') && (
                      <p className="mt-1 text-xs text-gray-500">
                        Tip: Use commas to require multiple words, e.g. "address, change" matches only if both words are present
                      </p>
                    )}
                    {createRuleMutation.error && (
                      <p className="mt-2 text-sm text-red-500">{createRuleMutation.error.message}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {tags?.length === 0 && (
          <div className="text-center py-12 bg-white rounded-lg border">
            <Tag className="w-12 h-12 text-gray-500 mx-auto mb-4" />
            <p className="text-gray-900">No tags created yet</p>
            <p className="text-sm text-gray-900">Create tags to organize your threads</p>
          </div>
        )}
      </div>
    </div>
  );
}
