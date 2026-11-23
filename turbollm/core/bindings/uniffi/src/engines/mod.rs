//! The engine layer's UniFFI surface (arch 2.7, 3.3): the records Kotlin sees, their conversions to and from the
//! domain, and the failure mapping.

/// `From` both ways between a binding enum and the domain enum whose variants carry the same names.
macro_rules! same_variants {
    ($kotlin:ident <=> $domain:ident { $($variant:ident),+ $(,)? }) => {
        impl From<$domain> for $kotlin {
            fn from(value: $domain) -> Self {
                match value {
                    $($domain::$variant => $kotlin::$variant,)+
                }
            }
        }

        impl From<$kotlin> for $domain {
            fn from(value: $kotlin) -> Self {
                match value {
                    $($kotlin::$variant => $domain::$variant,)+
                }
            }
        }
    };
}

pub mod dto;
pub mod failure;
