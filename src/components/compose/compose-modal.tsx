'use client';

/**
 * Compose modal - Create new email threads
 */

import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Send, Paperclip, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { cn } from '@/lib/utils';

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (threadId: string) => void;
  // Pre-fill fields (e.g., when composing to a specific customer)
  defaultTo?: string;
  defaultToName?: string;
  defaultSubject?: string;
}

interface ComposeData {
  to: string;
  toName?: string;
  subject: string;
  bodyHtml: string;
  attachments: File[];
}

// Inner form component that resets when key changes
function ComposeForm({
  onClose,
  onSuccess,
  defaultTo,
  defaultToName,
  defaultSubject,
}: Omit<ComposeModalProps, 'isOpen'>) {
  const [to, setTo] = useState(defaultTo || '');
  const [toName, setToName] = useState(defaultToName || '');
  const [subject, setSubject] = useState(defaultSubject || '');
  const [bodyHtml, setBodyHtml] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [errors, setErrors] = useState<{ to?: string; subject?: string; body?: string }>({});

  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const composeMutation = useMutation({
    mutationFn: async (data: ComposeData) => {
      const formData = new FormData();
      formData.append('to', data.to);
      if (data.toName) formData.append('toName', data.toName);
      formData.append('subject', data.subject);
      formData.append('bodyHtml', data.bodyHtml);
      formData.append('bodyText', data.bodyHtml.replace(/<[^>]*>/g, ''));

      for (const file of data.attachments) {
        formData.append('attachments', file);
      }

      const res = await fetch('/api/threads/compose', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to send email');
      }

      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      onClose();
      if (onSuccess && data.thread?.id) {
        onSuccess(data.thread.id);
      }
    },
  });

  const validate = (): boolean => {
    const newErrors: typeof errors = {};

    if (!to.trim()) {
      newErrors.to = 'Recipient email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      newErrors.to = 'Invalid email address';
    }

    if (!subject.trim()) {
      newErrors.subject = 'Subject is required';
    }

    const textContent = bodyHtml.replace(/<[^>]*>/g, '').trim();
    if (!textContent) {
      newErrors.body = 'Message body is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    composeMutation.mutate({
      to: to.trim(),
      toName: toName.trim() || undefined,
      subject: subject.trim(),
      bodyHtml,
      attachments,
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      setAttachments((prev) => [...prev, ...Array.from(files)]);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">New Message</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {/* To field */}
            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  label="To"
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="recipient@example.com"
                  error={errors.to}
                  disabled={composeMutation.isPending}
                />
              </div>
              <div className="w-1/3">
                <Input
                  label="Name (optional)"
                  type="text"
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                  placeholder="John Doe"
                  disabled={composeMutation.isPending}
                />
              </div>
            </div>

            {/* Subject */}
            <Input
              label="Subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter subject..."
              error={errors.subject}
              disabled={composeMutation.isPending}
            />

            {/* Body */}
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1">
                Message
              </label>
              <RichTextEditor
                value={bodyHtml}
                onChange={setBodyHtml}
                placeholder="Type your message..."
                disabled={composeMutation.isPending}
                className={cn(errors.body && 'border-red-300')}
              />
              {errors.body && (
                <p className="mt-1 text-sm text-red-600">{errors.body}</p>
              )}
            </div>

            {/* Attachments */}
            {attachments.length > 0 && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-900">
                  Attachments
                </label>
                <div className="flex flex-wrap gap-2">
                  {attachments.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-lg text-sm"
                    >
                      <Paperclip className="w-3.5 h-3.5 text-gray-500" />
                      <span className="text-gray-700 max-w-[200px] truncate">
                        {file.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        className="p-0.5 text-gray-400 hover:text-gray-600"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50">
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={composeMutation.isPending}
              >
                <Paperclip className="w-4 h-4 mr-1.5" />
                Attach
              </Button>
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={composeMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={composeMutation.isPending}
              >
                {composeMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-1.5" />
                    Send
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Error message */}
          {composeMutation.isError && (
            <div className="px-6 py-3 bg-red-50 border-t border-red-200">
              <p className="text-sm text-red-600">
                {composeMutation.error instanceof Error
                  ? composeMutation.error.message
                  : 'Failed to send email'}
              </p>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

// Counter for generating unique keys when modal opens
let modalOpenCount = 0;

export function ComposeModal({
  isOpen,
  onClose,
  onSuccess,
  defaultTo = '',
  defaultToName = '',
  defaultSubject = '',
}: ComposeModalProps) {
  // Track the key for resetting form state
  const formKeyRef = useRef(0);
  const wasOpenRef = useRef(false);

  // Update key when modal transitions from closed to open
  if (isOpen && !wasOpenRef.current) {
    modalOpenCount++;
    formKeyRef.current = modalOpenCount;
  }
  wasOpenRef.current = isOpen;

  if (!isOpen) return null;

  return (
    <ComposeForm
      key={formKeyRef.current}
      onClose={onClose}
      onSuccess={onSuccess}
      defaultTo={defaultTo}
      defaultToName={defaultToName}
      defaultSubject={defaultSubject}
    />
  );
}
