package com.shadowagent.voice.core;

import android.bluetooth.BluetoothDevice;
import org.junit.Test;

import java.io.IOException;

import static org.junit.Assert.*;

/** No adapter, radio, phone, or discovery is used by these checks. */
public final class BluetoothBridgeClientTest {
    @Test public void closedClientCannotStartLateHealthOrUpload() throws Exception {
        try (BluetoothBridgeClient client = new BluetoothBridgeClient(null, PairingFixture.pairing(), "00:11:22:33:44:55")) {
            client.close();
            assertThrows(IOException.class, client::health);
            assertThrows(IOException.class, () -> client.upload(null));
        }
    }

    @Test public void malformedAddressRejectedWithoutOpeningAdapter() {
        for (String address : new String[]{null, "", "aa:bb:cc:dd:ee:ff", "001122334455", "00:11:22:33:44:GG"}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                    () -> new BluetoothBridgeClient(null, PairingFixture.pairing(), address));
            assertEquals("Invalid Bluetooth address format.", error.getMessage());
        }
    }

    @Test public void onlyCompletedSystemBondIsAccepted() throws Exception {
        BluetoothBridgeClient.requireBonded(BluetoothDevice.BOND_BONDED);
        for (int state : new int[]{BluetoothDevice.BOND_NONE, BluetoothDevice.BOND_BONDING, -1}) {
            IOException error = assertThrows(IOException.class, () -> BluetoothBridgeClient.requireBonded(state));
            assertEquals(BridgeHealth.State.NEEDS_PAIRING, BridgeHealth.classify(error));
        }
        assertEquals("7f8d8f62-7147-4a92-a23b-0cb593d41210", BluetoothBridgeClient.RFCOMM_SERVICE_UUID);
    }
}
