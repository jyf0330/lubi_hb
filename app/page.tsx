import { TaskDashboard } from '@/components/task-dashboard';
import { getBoardData } from '@/lib/task-data';

export const dynamic = 'force-dynamic';

function todayInShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export default async function Home() {
  const today = todayInShanghai();
  const data = await getBoardData(today);
  return <TaskDashboard {...data} today={today} />;
}
