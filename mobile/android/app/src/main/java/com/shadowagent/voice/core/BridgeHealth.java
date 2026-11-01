package com.shadowagent.voice.core;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLException;

/** Session-local readiness; a delayed response cannot authenticate a different BLE connection. */
public final class BridgeHealth {
    public enum State { UNCHECKED, CHECKING, READY, UNREACHABLE, CERTIFICATE, UNAUTHORIZED, WRONG_DEVICE, INVALID_RESPONSE, FAILED, NEEDS_PAIRING }
    public static final long FRESH_MS = 15_000;
    private final long freshMs;
    private int generation;
    private long verifiedAt = -1;
    private State result = State.UNCHECKED;

    public BridgeHealth() { this(FRESH_MS); }
    public BridgeHealth(long freshMs) {
        if (freshMs <= 0) throw new IllegalArgumentException("Health freshness must be positive.");
        this.freshMs = freshMs;
    }

    public void connectionChanged() {
        generation++;
        verifiedAt = -1;
        result = State.UNCHECKED;
    }

    public int begin() {
        result = State.CHECKING;
        return ++generation;
    }

    public void complete(int requestGeneration, long now, State outcome) {
        if (outcome == State.CHECKING || outcome == State.UNCHECKED)
            throw new IllegalArgumentException("A health request requires a terminal result.");
        if (requestGeneration != generation) return;
        verifiedAt = outcome == State.READY ? now : -1;
        result = outcome;
    }

    public boolean ready(long now) {
        return verifiedAt >= 0 && now >= verifiedAt && now - verifiedAt <= freshMs;
    }

    public State state(long now) {
        if (ready(now)) return State.READY;
        return result == State.READY ? State.UNCHECKED : result;
    }

    public static String label(State state) {
        return switch (state) {
            case UNCHECKED -> "等待验证";
            case CHECKING -> "正在验证";
            case READY -> "已验证";
            case UNREACHABLE -> "网络不可达";
            case CERTIFICATE -> "证书验证失败";
            case UNAUTHORIZED -> "配对口令被拒绝";
            case WRONG_DEVICE -> "电脑身份不匹配";
            case INVALID_RESPONSE -> "服务响应异常";
            case FAILED -> "连接检查失败";
            case NEEDS_PAIRING -> "等待系统蓝牙配对";
        };
    }

    public static String warning(State state) {
        return switch (state) {
            case UNREACHABLE -> "无法连接电脑接收端。请检查接收程序、同一局域网及 VPN 的局域网访问设置；电脑地址由蓝牙自动刷新。";
            case CERTIFICATE -> "电脑证书指纹、有效期或固定名称与配对不符。请核对时间和配对文件，不要关闭证书校验。";
            case UNAUTHORIZED -> "电脑拒绝了配对口令，请从正确电脑重新导入配对文件。";
            case WRONG_DEVICE -> "接收端不是已配对的电脑，已阻止上传。";
            case INVALID_RESPONSE -> "电脑接收端响应不符合协议，请检查桥接版本和服务状态。";
            case FAILED -> "上传通道检查失败，将自动重试；本机录音原件仍保留。";
            case NEEDS_PAIRING -> "请在手机和电脑的系统蓝牙设置中完成首次配对，并核对双方配对码。";
            default -> "";
        };
    }

    static IOException failure(State state) { return new Failure(state); }

    public static State classify(Throwable error) {
        // Do not expose raw server bodies, addresses or exception messages in diagnostics.
        for (int depth = 0; error != null && depth < 8; depth++, error = error.getCause()) {
            if (error instanceof Failure) return ((Failure) error).state;
            if (error instanceof SSLException) return State.CERTIFICATE;
            if (error instanceof SocketTimeoutException || error instanceof ConnectException || error instanceof NoRouteToHostException)
                return State.UNREACHABLE;
        }
        return State.FAILED;
    }

    private static final class Failure extends IOException {
        final State state;
        Failure(State state) { super(label(state)); this.state = state; }
    }
}
