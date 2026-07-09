export const USER_SETTINGS_UPDATED_EVENT = "tomverse:user-settings-updated";

export type UserSettingsUpdatedDetail = {
    defaultModel: string;
};

export const notifyUserSettingsUpdated = (
    detail: UserSettingsUpdatedDetail
) => {
    window.dispatchEvent(
        new CustomEvent<UserSettingsUpdatedDetail>(
            USER_SETTINGS_UPDATED_EVENT,
            { detail }
        )
    );
};
