//! AMUX Decision Maker bridge relay, stage S2-2b2
//! (docs/policy/amux-decision-maker.md §2-1 to §2-5, §3, §5, §9, §10).
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
//! Not here: delivering an operator-confirmed answer to the worker (stage
//! S2-2b3), the repository snapshot (stage S2b) and any Admin screen. No path
//! from a DM output to a worker exists in this module.

pub mod flow;
pub mod io;
pub mod wire;

/// Starts the relay beside the bridge when its switch says so. The local
/// AMUX client and base URL are the bridge's own (loopback only, no proxy,
/// no redirect), and the app client is the bridge's `TomverseApi` with its
/// sync token.
pub fn start_from_env(
    api: &crate::tomverse_api::TomverseApi,
    local_client: &reqwest::Client,
    local_base: &str,
) {
    let enabled = std::env::var(io::DM_RELAY_ENV).ok();
    let token = std::env::var(io::DM_RELAY_LOCAL_TOKEN_ENV).ok();
    match io::relay_activation(enabled.as_deref(), token.as_deref()) {
        io::RelayActivation::Off => {}
        io::RelayActivation::Misconfigured(name) => {
            eprintln!("amux dm relay is not started: {name} is missing or malformed");
        }
        io::RelayActivation::On { local_token } => {
            println!("amux dm relay started");
            let relay = io::Relay::new(
                io::HttpApp::new(api.clone()),
                io::HttpLocalAmux::new(local_client.clone(), local_base.to_owned(), local_token),
                io::UnixBroker::system(),
                wire::DM_SEND_OPTION_EFFECTS,
            );
            tokio::spawn(io::run(relay));
        }
    }
}
