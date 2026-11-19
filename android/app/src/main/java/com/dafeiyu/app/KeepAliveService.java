package com.dafeiyu.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台服务：让系统别在后台把 App 顺手杀掉（MIUI 尤其积极）。
 * 不参与业务逻辑，只挂一条常驻通知把进程留住。
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "dafeiyu_keepalive";
    private static final int NOTI_ID = 1001;

    public static void start(Context ctx) {
        try {
            Intent i = new Intent(ctx, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception ignored) {
            // 系统不让起就算了，不能影响正常聊天
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);

            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

            b.setContentTitle("大肥鱼")
                    .setContentText("在这儿待着，点一下继续聊天")
                    .setSmallIcon(android.R.drawable.sym_action_chat)
                    .setContentIntent(pi)
                    .setOngoing(true);

            startForeground(NOTI_ID, b.build());
        } catch (Exception ignored) {
            // 通知权限被拒等情况：服务照活，只是没通知
        }
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台常驻", NotificationManager.IMPORTANCE_MIN);
            ch.setDescription("保持大肥鱼在后台运行");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } catch (Exception ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}