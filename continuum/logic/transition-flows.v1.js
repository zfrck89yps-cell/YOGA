export const TRANSITION_FLOWS = {
  "upright->grounded": [
    ["hands_to_floor"],
    ["roll_down", "hands_to_floor"],
    ["shift_weight_forward", "hands_to_floor"],
    ["step_feet_wider", "hands_to_floor"],
    // only if next pose is plank/table-ish (enforced by scoring now)
    ["hands_to_floor", "swing_legs_back"],
    ["hands_to_floor", "step_back_to_plank"],
  ],

  "grounded->upright": [
    ["walk_hands_back", "rise_up"],
    ["shift_weight_back", "walk_hands_back", "rise_up"],
    ["walk_hands_back", "step_feet_together", "rise_up"],
    ["rise_up"], // only if already basically upright
  ],

  "upright->seated": [
    ["roll_down", "hands_to_floor", "lower_to_seat"],
    ["hands_to_floor", "lower_to_seat"],
    ["kneel_down", "lower_to_seat"],
    ["lower_to_seat"],
  ],

  "seated->upright": [
    ["hands_to_floor", "rise_up"],
    ["hands_to_floor", "walk_hands_back", "rise_up"],
    ["press_up_to_seated", "hands_to_floor", "rise_up"],
    ["rise_up"],
  ],

  "grounded->seated": [
    ["lower_to_seat"],
    ["press_up_to_seated"],
    ["shift_weight_back", "lower_to_seat"],
    ["swing_legs_forward"],
    ["return_to_tabletop", "lower_to_seat"],
  ],

    "seated->grounded": [
      ["press_up_to_tabletop"],
      ["press_to_table"],
      ["return_to_tabletop"],
      // only if you *must* (or you later tag "needs_vinyasa" or similar)
      ["hands_to_floor", "swing_legs_back"],
      ["hands_to_floor", "step_back_to_plank"],
  ],

  "grounded->supine": [
    ["roll_to_back"],
    ["lower_to_seat", "roll_to_back"],
    ["swing_legs_forward", "roll_to_back"],
    ["lower_to_elbows", "roll_to_back"],
  ],

  "supine->grounded": [
    ["roll_to_seated", "press_up_to_tabletop"],
    ["roll_to_seated", "press_to_table"],
    ["roll_to_side", "press_up_to_tabletop"],
    ["roll_to_side", "press_to_table"],
  ],

  "seated->supine": [
    ["roll_to_back"],
    // ["lower_to_elbows", "roll_to_back"], // optional if this movement makes sense for your flow
  ],

  "supine->seated": [
    ["roll_to_seated"],
    ["roll_to_side", "press_up_to_seated"],
  ],

  "supine->prone": [
    ["roll_to_side", "lower_to_belly"],
    ["roll_to_side", "lower_to_elbows", "lower_to_belly"],
  ],

  "prone->supine": [
    ["roll_to_side"],
    ["lower_to_elbows", "roll_to_side"],
  ],

  "grounded->prone": [
    ["lower_to_belly"],
    ["lower_to_elbows", "lower_to_belly"],
    ["shift_weight_forward", "lower_to_belly"],
  ],

  "prone->grounded": [
    ["press_to_table"],
    ["return_to_tabletop"],
    ["press_up_to_tabletop"],
  ],

  "upright->supine": [
    ["kneel_down", "lower_to_seat", "roll_to_back"],
    ["roll_down", "hands_to_floor", "lower_to_seat", "roll_to_back"],
  ],

  "supine->upright": [
    ["roll_to_seated", "hands_to_floor", "rise_up"],
    ["roll_to_side", "press_up_to_seated", "hands_to_floor", "rise_up"],
  ],
};