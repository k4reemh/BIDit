/**
 * Notifications — one place to tell a user something happened, in-app (a row they
 * poll for the bell) and by email (Resend, best-effort). Safe to call from money
 * paths: it never throws, and the email is fired in the background so it can't
 * slow a settlement.
 */
import { prisma as defaultPrisma } from './db.js';
import type { PrismaClient } from './db.js';
import { sendEmail, emailShell, paragraph } from './email.js';

export interface NotifyInput {
  userId: string;
  kind: string;
  title: string;
  body?: string;
  /** In-app link, e.g. '/ship' or '/seller/shipments'. */
  href?: string;
  /** Also send email (default true). Set false for low-value in-app-only pings. */
  email?: boolean;
}

export async function notify(input: NotifyInput, prisma: PrismaClient = defaultPrisma): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId: input.userId, kind: input.kind, title: input.title, body: input.body ?? null, href: input.href ?? null },
    });
  } catch (err) {
    console.error('[notify] create failed', (err as Error)?.message ?? err);
    return;
  }
  if (input.email === false) return;
  // Fire the email in the background — never block or throw in the caller.
  void (async () => {
    try {
      const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true } });
      if (!user?.email) return;
      const base = process.env.BIDIT_WEB_URL?.replace(/\/$/, '') ?? '';
      const href = input.href && base ? `${base}${input.href}` : base || undefined;
      await sendEmail({
        to: user.email,
        subject: input.title,
        html: emailShell(input.title, input.body ? paragraph(input.body) : '', href),
      });
    } catch (err) {
      console.error('[notify] email failed', (err as Error)?.message ?? err);
    }
  })();
}

export async function listNotifications(userId: string, prisma: PrismaClient = defaultPrisma) {
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return {
    unread,
    items: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      href: n.href,
      read: n.readAt !== null,
      createdAt: n.createdAt.getTime(),
    })),
  };
}

export async function markAllRead(userId: string, prisma: PrismaClient = defaultPrisma): Promise<void> {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}
