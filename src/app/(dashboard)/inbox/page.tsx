'use client';

/**
 * Inbox page - main helpdesk view
 */

import { useState } from 'react';
import { InboxList } from '@/components/inbox/inbox-list';
import { ThreadView } from '@/components/thread/thread-view';
import { CustomerSidebar } from '@/components/sidebar/customer-sidebar';
import { Inbox } from 'lucide-react';

export default function InboxPage() {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  return (
    <div className="flex h-full min-w-0">
      {/* Inbox list */}
      <div className="flex-[0_1_20rem] min-w-[14rem] max-w-[22rem] border-r">
        <InboxList
          selectedThreadId={selectedThreadId || undefined}
          onSelectThread={setSelectedThreadId}
        />
      </div>

      {/* Thread view */}
      <div className="flex-1 min-w-0 border-r">
        {selectedThreadId ? (
          <ThreadView
            threadId={selectedThreadId}
            onThreadDeleted={() => setSelectedThreadId(null)}
            onSelectThread={setSelectedThreadId}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-gray-500">
            <Inbox className="w-12 h-12 mb-4" />
            <p className="text-lg font-medium">Select a conversation</p>
            <p className="text-sm">Choose a thread from the inbox to view</p>
          </div>
        )}
      </div>

      {/* Customer sidebar */}
      <div className="flex-[0_1_22rem] min-w-[16rem] max-w-[26rem]">
        {selectedThreadId ? (
          <CustomerSidebar threadId={selectedThreadId} />
        ) : (
          <div className="h-full bg-white" />
        )}
      </div>
    </div>
  );
}
