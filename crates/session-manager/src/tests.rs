use super::*;
use serde_json::json;

fn surface(id: &str) -> SurfaceRecord {
    SurfaceRecord {
        id: id.into(),
        kind: "terminal".into(),
        title: format!("Terminal {id}"),
        custom_title: false,
        shell_profile_id: Some("powershell".into()),
        cwd: Some(r"C:\src".into()),
        last_run: None,
    }
}

fn workspace(id: &str, panes: Vec<PaneRecord>) -> WorkspaceRecord {
    let first = panes[0].id.clone();
    WorkspaceRecord {
        id: id.into(),
        name: format!("ws {id}"),
        color: "#7c8cff".into(),
        icon: None,
        cwd: Some(r"C:\src".into()),
        pinned: false,
        layout: json!({"type": "leaf", "id": "n1", "paneId": first}),
        focused_pane_id: Some(first),
        shell_profile_id: None,
        startup_commands: vec!["git status".into()],
        env: BTreeMap::from([("FOO".into(), "bar".into())]),
        panes,
        created_at: 0,
    }
}

fn pane(id: &str, surfaces: &[&str]) -> PaneRecord {
    PaneRecord {
        id: id.into(),
        active_surface_id: surfaces.first().map(|s| s.to_string()),
        surfaces: surfaces.iter().map(|s| surface(s)).collect(),
    }
}

fn normalize(mut s: SessionSnapshot) -> SessionSnapshot {
    for ws in &mut s.workspaces {
        ws.created_at = 0;
        for p in &mut ws.panes {
            for sf in &mut p.surfaces {
                sf.last_run = None;
            }
        }
    }
    s
}

#[test]
fn migrations_apply_and_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wmux.db");
    {
        let (store, outcome) = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), 1);
        assert!(outcome.recovered_from.is_none());
    }
    let (store, _) = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
}

#[test]
fn snapshot_roundtrip_preserves_order_and_structure() {
    let mut store = Store::open_in_memory().unwrap();
    let snap = SessionSnapshot {
        workspaces: vec![
            workspace("b", vec![pane("p1", &["s1", "s2"]), pane("p2", &["s3"])]),
            workspace("a", vec![pane("p3", &["s4"])]),
        ],
        active_workspace_id: Some("a".into()),
        ui: json!({"sidebarWidth": 260}),
    };
    store.save_snapshot(&snap).unwrap();
    let loaded = store.load_snapshot().unwrap();
    assert_eq!(normalize(loaded), snap);
}

#[test]
fn removed_entities_are_deleted_and_runtime_columns_survive() {
    let mut store = Store::open_in_memory().unwrap();
    let mut snap = SessionSnapshot {
        workspaces: vec![workspace("w", vec![pane("p1", &["s1", "s2"])])],
        ..Default::default()
    };
    store.save_snapshot(&snap).unwrap();
    store.record_terminal_started("s1", 4242, "pwsh.exe").unwrap();
    store.record_terminal_exited("s1", Some(0)).unwrap();

    // Remove s2 and save again.
    snap.workspaces[0].panes[0].surfaces.pop();
    store.save_snapshot(&snap).unwrap();
    let loaded = store.load_snapshot().unwrap();
    let surfaces = &loaded.workspaces[0].panes[0].surfaces;
    assert_eq!(surfaces.len(), 1);
    let run = surfaces[0].last_run.as_ref().expect("runtime info kept");
    assert_eq!(run.pid, Some(4242));
    assert_eq!(run.exit_code, Some(0));

    // Removing the workspace cascades everything.
    snap.workspaces.clear();
    store.save_snapshot(&snap).unwrap();
    for table in ["terminal_sessions", "terminal_runs", "surfaces", "panes"] {
        let count: i64 = store
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table} should be empty");
    }
}

#[test]
fn terminal_started_before_first_save_is_still_recorded() {
    let mut store = Store::open_in_memory().unwrap();
    // Backend records the run before the UI's debounced save created the row.
    store.record_terminal_started("early", 77, "cmd.exe").unwrap();
    let snap = SessionSnapshot {
        workspaces: vec![workspace("w", vec![pane("p", &["early"])])],
        ..Default::default()
    };
    store.save_snapshot(&snap).unwrap();
    let loaded = store.load_snapshot().unwrap();
    let run = loaded.workspaces[0].panes[0].surfaces[0].last_run.clone().unwrap();
    assert_eq!(run.pid, Some(77));
    assert_eq!(run.program.as_deref(), Some("cmd.exe"));
}

#[test]
fn moving_a_pane_between_workspaces_is_an_update() {
    let mut store = Store::open_in_memory().unwrap();
    let mut snap = SessionSnapshot {
        workspaces: vec![
            workspace("w1", vec![pane("p1", &["s1"]), pane("p2", &["s2"])]),
            workspace("w2", vec![pane("p3", &["s3"])]),
        ],
        ..Default::default()
    };
    store.save_snapshot(&snap).unwrap();
    let moved = snap.workspaces[0].panes.remove(1);
    snap.workspaces[1].panes.push(moved);
    store.save_snapshot(&snap).unwrap();
    let loaded = store.load_snapshot().unwrap();
    assert_eq!(loaded.workspaces[0].panes.len(), 1);
    assert_eq!(loaded.workspaces[1].panes.len(), 2);
    assert_eq!(loaded.workspaces[1].panes[1].id, "p2");
}

#[test]
fn invalid_snapshots_are_rejected() {
    let mut store = Store::open_in_memory().unwrap();
    let dup = SessionSnapshot {
        workspaces: vec![workspace("w", vec![pane("p", &["x", "x"])])],
        ..Default::default()
    };
    assert!(matches!(store.save_snapshot(&dup), Err(StoreError::Invalid(_))));
    let mut bad_kind = SessionSnapshot {
        workspaces: vec![workspace("w", vec![pane("p", &["x"])])],
        ..Default::default()
    };
    bad_kind.workspaces[0].panes[0].surfaces[0].kind = "rocket".into();
    assert!(store.save_snapshot(&bad_kind).is_err());
}

#[test]
fn settings_roundtrip() {
    let mut store = Store::open_in_memory().unwrap();
    let values = BTreeMap::from([
        ("appearance.theme".to_string(), json!("dark")),
        ("terminal.fontSize".to_string(), json!(14)),
    ]);
    store.set_settings(&values).unwrap();
    store
        .set_settings(&BTreeMap::from([("terminal.fontSize".to_string(), json!(15))]))
        .unwrap();
    let got = store.get_settings().unwrap();
    assert_eq!(got["appearance.theme"], json!("dark"));
    assert_eq!(got["terminal.fontSize"], json!(15));
}

#[test]
fn corrupt_database_is_moved_aside_and_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wmux.db");
    std::fs::write(&path, b"this is definitely not a sqlite database, just garbage bytes......").unwrap();
    let (store, outcome) = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
    let aside = outcome.recovered_from.expect("recovered");
    assert!(aside.exists());
}

#[test]
fn backup_produces_a_usable_copy() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("wmux.db")).unwrap().0;
    let snap = SessionSnapshot {
        workspaces: vec![workspace("w", vec![pane("p", &["s"])])],
        ..Default::default()
    };
    store.save_snapshot(&snap).unwrap();
    let dest = dir.path().join("backup.db");
    store.backup_to(&dest).unwrap();
    let (copy, _) = Store::open(&dest).unwrap();
    assert_eq!(copy.load_snapshot().unwrap().workspaces.len(), 1);
}

#[test]
fn history_is_pruned() {
    let store = Store::open_in_memory().unwrap();
    for i in 0..20 {
        store
            .append_history("test", None, None, &json!({ "i": i }))
            .unwrap();
    }
    assert_eq!(store.prune_history(5).unwrap(), 15);
}
