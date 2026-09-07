import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '西游 · 生产作战室',
  description: 'ZHC 与 YWT 的每日任务、计时、交付和验收看板',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
