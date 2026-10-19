//! AMUX Decision Maker bridge relay, stages S2-2b2 and S2-2b3
//! (docs/policy/amux-decision-maker.md §2, §3, §5, §7, §9, §10).
//!
//! The bridge's half of a Decision Maker request, from a worker's typed ask
//! on the local AMUX to the DM's result in the app's ledger: route the card,
//! take the assignment, mark the card DM-pending by one compare-and-swap,
//! record the transmission intent, hand the payload to the broker only on the
//! intent's recorded answer, submit the result (a lost answer settled by
//! lookup alone), report a cleanup the broker could not confirm, record the
//! receipt, and release the marker whatever happened. `flow` is the state
//! machine, `wire` its pure values, `io` the sockets and the loop.
//!
//! Off by default: nothing here runs unless `TOMVERSE_AMUX_DM_RELAY` is
//! exactly `enabled` (and the app's own `TOMVERSE_AMUX_DM_ROUTING` is a
//! separate switch, off on develop). The relay runs in the bridge process
//! (the `tomverse-bridge` service) as one task beside the worker loop and
//! never halts that loop; its own halt stops only new questions.
//!
//! Stage S2-2b3 (`delivery`, §2-7, §7, §9): each tick, before its question
//! scan, the relay carries at most one operator-confirmed answer to the
//! asking worker -- read from the app (confirmations only, nothing under the
//! kill switch), checked on the local AMUX, decided in the app, claimed and
//! sent by the local AMUX, and its receipt recorded; an unclear delivery is
//! recorded unknown and its session paused, never sent again. No DM output a
//! person has not confirmed reaches a worker: the question flow (`flow`)
//! writes only the marker, and the delivery sends only what the app gives out
//! for a confirmation, after the app recorded the delivery decision.
//!
//! Stage S2-2b4: a delivery the local AMUX proved sent nothing is recorded as
//! `not_sent` with its reason (`delivery`); at its start the relay settles
//! every decision a stopped bridge left without an outcome, from the local
//! records and never by sending again (`delivery::settle_unsettled`); and each
//! tick it reports the operator's direct answer records so the app closes
//! their questions' requests (`direct`, §2-7).
//!
//! Not here: the repository snapshot (stage S2b) and any Admin screen.

pub mod delivery;
pub mod direct;
pub mod flow;
pub mod io;
pub mod wire;

/// Exit status when the relay is enabled but its token is missing or
/// malformed. The unit does not restart on it (`RestartPreventExitStatus=`):
/// a configuration error waits for a person, not for the next minute.
pub const DM_RELAY_MISCONFIGURED_EXIT: i32 = 2;

/// Runs the relay as its own process: the binary's `--dm-relay` mode, one
/// systemd unit (`scripts/systemd/tomverse-amux-dm-relay.service`). A worker
/// bridge never runs it: every bridge unit reads the same environment file and
/// the relay releases every local marker at the start of each tick, so a
/// relay per bridge would release another relay's marker in the middle of its
/// question. The local AMUX client and base URL are built the way a bridge
/// builds them (loopback only, no proxy, no redirect), and the app client is
/// the bridge's `TomverseApi` with its sync token. Off returns 0 and the
/// relay's loop never returns.
pub async fn run_from_env(
    api: crate::tomverse_api::TomverseApi,
    local_client: reqwest::Client,
    local_base: String,
) -> i32 {
    let enabled = std::env::var(io::DM_RELAY_ENV).ok();
    let token = std::env::var(io::DM_RELAY_LOCAL_TOKEN_ENV).ok();
    match io::relay_activation(enabled.as_deref(), token.as_deref()) {
        io::RelayActivation::Off => {
            println!("amux dm relay is off");
            0
        }
        io::RelayActivation::Misconfigured(name) => {
            eprintln!("amux dm relay is not started: {name} is missing or malformed");
            DM_RELAY_MISCONFIGURED_EXIT
        }
        io::RelayActivation::On { local_token } => {
            println!("amux dm relay started");
            let relay = io::Relay::new(
                io::HttpApp::new(api),
                io::HttpLocalAmux::new(local_client, local_base, local_token),
                io::UnixBroker::system(),
                wire::DM_SEND_OPTION_EFFECTS,
            );
            io::run(relay).await;
            0
        }
    }
}
