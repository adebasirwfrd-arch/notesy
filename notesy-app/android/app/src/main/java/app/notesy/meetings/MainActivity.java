package app.notesy.meetings;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotesyCapturePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
